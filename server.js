const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- DATABASE & LOGGING ---
const DB_FILE = 'database.json';
let users = {};
if (fs.existsSync(DB_FILE)) { try { users = JSON.parse(fs.readFileSync(DB_FILE)); } catch(e){ users = {}; } }

function saveDatabase() { fs.writeFileSync(DB_FILE, JSON.stringify(users, null, 2)); }
function logHistory(username, msg, bal) {
    if(!users[username].history) users[username].history = [];
    users[username].history.unshift(`[${new Date().toLocaleTimeString()}] ${msg} | BAL: ${bal}`);
    if(users[username].history.length > 50) users[username].history.pop();
}

let activeSockets = {}; 
let playerCounts = { lobby: 0, colorgame: 0, roulette: 0 };
let chatHistory = { colorgame: [], roulette: [] };
let rouletteHistory = []; 

app.use(express.static(__dirname));
app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });

// ==========================================
//  ROULETTE GAME ENGINE (STATE MACHINE)
// ==========================================
let rState = {
    phase: 'BETTING', // BETTING, PROCESSING
    timeLeft: 20,
    bets: [] 
};

// Main Heartbeat (1 Second Tick)
setInterval(() => {
    
    // PHASE 1: BETTING (Countdown)
    if(rState.phase === 'BETTING') {
        rState.timeLeft--;
        
        // Broadcast Timer to ALL clients
        io.to('roulette').emit('roulette_state_update', {
            phase: 'BETTING',
            time: rState.timeLeft
        });

        // 3... 2... 1... Audio Trigger handled by Client based on time

        // TIME UP -> START GAME SEQUENCE
        if(rState.timeLeft <= 0) {
            startRouletteRound();
        }
    }

}, 1000);

function startRouletteRound() {
    rState.phase = 'PROCESSING';
    
    // 1. LOCK BETS (Immediate)
    io.to('roulette').emit('roulette_state_update', { phase: 'LOCKED', time: 0 });

    // 2. GENERATE RESULT
    let resultNum = Math.floor(Math.random() * 37);
    rouletteHistory.unshift(resultNum);
    if(rouletteHistory.length > 23) rouletteHistory.pop();

    // 3. BROADCAST SPIN (Clients will show Wheel)
    // Spin Duration on Client is fixed (e.g. 4s)
    io.to('roulette').emit('roulette_spin_start', resultNum);

    // 4. CALCULATE WINNERS (Internal)
    let roundWinners = [];
    rState.bets.forEach(bet => {
        if(bet.numbers.includes(resultNum)) {
            let count = bet.numbers.length;
            // Payout Multipliers: 1->36x, 2->18x, 3->12x, 4->9x, 6->6x, 12->3x, 18->2x
            let payoutMult = (count===1)?36 : (count===2)?18 : (count===3)?12 : (count===4)?9 : (count===6)?6 : (count===12)?3 : 2;
            let winAmount = bet.amount * payoutMult;
            
            if(users[bet.username]) {
                users[bet.username].balance += winAmount;
                roundWinners.push({ 
                    socketId: bet.socketId, 
                    win: winAmount, 
                    bal: users[bet.username].balance 
                });
                logHistory(bet.username, `WIN Roulette +${winAmount}`, users[bet.username].balance);
            }
        }
    });
    saveDatabase();

    // 5. SCHEDULE PHASES (Server orchestrates the delay)
    // The client animation total duration is roughly 11 seconds.
    // We wait on the server before resetting.
    
    setTimeout(() => {
        // Send Payout Data (Triggers Coin Animation on Client)
        roundWinners.forEach(w => {
            io.to(w.socketId).emit('roulette_win_data', { amount: w.win, balance: w.bal, number: resultNum });
        });
        
        // Broadcast History Update
        io.to('roulette').emit('roulette_history', rouletteHistory);

        // 6. RESET ROUND (After animations finish)
        setTimeout(() => {
            rState.phase = 'BETTING';
            rState.timeLeft = 20;
            rState.bets = [];
            io.to('roulette').emit('roulette_reset'); // Clears chips
        }, 4000); // Time for Payout Anim (2s) + Buffer

    }, 7500); // Time for Spin (4s) + Hold (1.5s) + Reveal (2s)
}

// ==========================================
//  SOCKET HANDLING
// ==========================================
io.on('connection', (socket) => {
    
    // --- LOGIN ---
    socket.on('login', (data) => {
        if(users[data.username] && users[data.username].password === data.password) {
            joinRoom(socket, data.username, 'lobby');
            socket.emit('login_success', { username: data.username, balance: users[data.username].balance });
            // Send current state immediately so they don't see blank
            socket.emit('roulette_history', rouletteHistory);
            socket.emit('roulette_state_update', { phase: rState.phase, time: rState.timeLeft });
        } else { socket.emit('login_error', "Invalid Credentials"); }
    });

    socket.on('register', (data) => {
        if(!users[data.username]) {
            users[data.username] = { password: data.password, balance: 1000, history: [] };
            saveDatabase();
            joinRoom(socket, data.username, 'lobby');
            socket.emit('login_success', { username: data.username, balance: 1000 });
        } else { socket.emit('login_error', "Username taken"); }
    });

    // --- ROOMS ---
    socket.on('switch_room', (room) => {
        let u = activeSockets[socket.id];
        if(u) joinRoom(socket, u.username, room);
    });

    // --- CHAT ---
    socket.on('chat_msg', (data) => {
        let u = activeSockets[socket.id];
        if(u && data.msg) {
            let msgObj = { user: u.username, msg: data.msg };
            io.to(data.room).emit('chat_broadcast', msgObj);
        }
    });

    // --- BETTING (ROULETTE) ---
    socket.on('place_bet_roulette', (data) => {
        let u = activeSockets[socket.id];
        // STRICT CHECK: Betting must be open
        if(!u || rState.phase !== 'BETTING') return;
        
        if(users[u.username].balance >= data.amount) {
            users[u.username].balance -= data.amount;
            rState.bets.push({ 
                username: u.username, 
                numbers: data.numbers, 
                amount: data.amount, 
                socketId: socket.id 
            });
            // Ack balance update immediately for UI responsiveness
            socket.emit('update_balance', users[u.username].balance);
        }
    });

    // --- UNDO / CLEAR ---
    socket.on('roulette_clear', () => {
        let u = activeSockets[socket.id];
        if(!u || rState.phase !== 'BETTING') return;
        let userBets = rState.bets.filter(b => b.socketId === socket.id);
        if(userBets.length > 0) {
            let refund = userBets.reduce((a,b) => a + b.amount, 0);
            users[u.username].balance += refund;
            rState.bets = rState.bets.filter(b => b.socketId !== socket.id);
            socket.emit('update_balance', users[u.username].balance);
            socket.emit('bets_cleared');
        }
    });

    socket.on('roulette_undo', () => {
        let u = activeSockets[socket.id];
        if(!u || rState.phase !== 'BETTING') return;
        // Find last bet from this user
        let myBets = rState.bets.filter(b => b.socketId === socket.id);
        if(myBets.length > 0) {
            let lastBet = myBets[myBets.length - 1];
            users[u.username].balance += lastBet.amount;
            // Remove from main array (find index)
            let idx = rState.bets.lastIndexOf(lastBet);
            if(idx > -1) rState.bets.splice(idx, 1);
            
            socket.emit('update_balance', users[u.username].balance);
            socket.emit('bet_undone');
        }
    });

    // --- DISCONNECT ---
    socket.on('disconnect', () => {
        let u = activeSockets[socket.id];
        if(u) {
            if(playerCounts[u.room]) playerCounts[u.room]--;
            delete activeSockets[socket.id];
            io.emit('lobby_counts', playerCounts);
        }
    });
});

function joinRoom(socket, username, room) {
    if(activeSockets[socket.id]) {
        let old = activeSockets[socket.id].room;
        socket.leave(old);
        if(playerCounts[old] > 0) playerCounts[old]--;
    }
    activeSockets[socket.id] = { username: username, room: room };
    socket.join(room);
    if(playerCounts[room] !== undefined) playerCounts[room]++;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Casino Running on Port ${PORT}`));
