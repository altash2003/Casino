const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- DB & LOGS ---
const DB_FILE = 'database.json';
let users = {};

// Load DB or create if missing
if (fs.existsSync(DB_FILE)) { 
    try { users = JSON.parse(fs.readFileSync(DB_FILE)); } catch(e){ users = {}; } 
} else {
    saveDatabase();
}

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
    phase: 'BETTING', // BETTING, SPINNING, RESULT, PAYOUT
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
    // Spin Duration on Client is fixed (4s)
    io.to('roulette').emit('roulette_spin_start', resultNum);

    // 4. CALCULATE WINNERS (Internal)
    let roundWinners = [];
    rState.bets.forEach(bet => {
        if(bet.numbers.includes(resultNum)) {
            let count = bet.numbers.length;
            // Payout Logic
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
    // Timeline:
    // 0s: Start Spin (Duration 4s)
    // 4s: Wheel Stop & Hold (Duration 1.5s)
    // 5.5s: Wheel Hide, Reveal Table (Duration 1.5s)
    // 7s: Start Gather Anim (Duration 2s)
    // 9s: Start Payout Coin Anim (Duration 1.5s)
    
    setTimeout(() => {
        // This triggers the Gather -> Coin -> Balance Update
        roundWinners.forEach(w => {
            io.to(w.socketId).emit('roulette_win_data', { amount: w.win, balance: w.bal, number: resultNum });
        });
        
        // Broadcast History Update to everyone
        io.to('roulette').emit('roulette_history', rouletteHistory);
        // Also tell non-winners to animate the result gathering (without the coin)
        io.to('roulette').emit('roulette_result_generic', resultNum);

        // 6. RESET ROUND (After animations finish)
        setTimeout(() => {
            rState.phase = 'BETTING';
            rState.timeLeft = 20;
            rState.bets = [];
            io.to('roulette').emit('roulette_reset'); // Clears chips
        }, 4000); // Time for Payout Anim (2s + 1.5s buffer)

    }, 7500); // Time for Spin (4s) + Hold (1.5s) + Reveal (2s)
}


// --- COLOR GAME LOOP ---
let colorState = { status: 'BETTING', timeLeft: 20, bets: [] };
setInterval(() => {
    if(colorState.status === 'BETTING') {
        colorState.timeLeft--;
        if(colorState.timeLeft <= 3) io.to('colorgame').emit('countdown_beep', colorState.timeLeft);
        if(colorState.timeLeft <= 0) {
            colorState.status = 'ROLLING';
            const COLORS = ['RED', 'GREEN', 'BLUE', 'YELLOW', 'PINK', 'WHITE'];
            let result = [COLORS[Math.floor(Math.random()*6)], COLORS[Math.floor(Math.random()*6)], COLORS[Math.floor(Math.random()*6)]];
            io.to('colorgame').emit('game_rolling');
            setTimeout(() => {
                io.to('colorgame').emit('game_result', result);
                colorState.bets.forEach(bet => {
                    let matches = result.filter(c => c === bet.color).length;
                    if(matches > 0) {
                        let win = bet.amount * (matches + 1);
                        if(users[bet.username]) {
                            users[bet.username].balance += win;
                            io.to(bet.socketId).emit('win_notification', { game: 'COLOR GAME', amount: win });
                            io.to(bet.socketId).emit('update_balance', users[bet.username].balance);
                        }
                    }
                });
                saveDatabase();
                setTimeout(() => {
                    colorState.status = 'BETTING'; colorState.timeLeft = 20; colorState.bets = [];
                    io.to('colorgame').emit('timer_update', 20);
                    io.to('colorgame').emit('game_reset');
                }, 5000);
            }, 3000);
        } else { io.to('colorgame').emit('timer_update', colorState.timeLeft); }
    }
}, 1000);

// --- SOCKETS ---
io.on('connection', (socket) => {
    io.emit('lobby_counts', playerCounts);

    socket.on('login', (data) => {
        if(users[data.username] && users[data.username].password === data.password) {
            joinRoom(socket, data.username, 'lobby');
            socket.emit('login_success', { username: data.username, balance: users[data.username].balance });
            // Send current state immediately
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

    socket.on('switch_room', (room) => {
        let u = activeSockets[socket.id];
        if(u) joinRoom(socket, u.username, room);
    });

    socket.on('chat_msg', (data) => {
        let u = activeSockets[socket.id];
        if(u && data.msg) {
            let msgObj = { user: u.username, msg: data.msg };
            io.to(data.room).emit('chat_broadcast', msgObj);
        }
    });

    socket.on('place_bet', (data) => { 
        let u = activeSockets[socket.id];
        if(!u || colorState.status !== 'BETTING') return;
        if(users[u.username].balance >= data.amount) {
            users[u.username].balance -= data.amount;
            colorState.bets.push({ username: u.username, color: data.color, amount: data.amount, socketId: socket.id });
            socket.emit('update_balance', users[u.username].balance);
        }
    });

    socket.on('place_bet_roulette', (data) => {
        let u = activeSockets[socket.id];
        if(!u || rState.phase !== 'BETTING') return; 
        if(users[u.username].balance >= data.amount) {
            users[u.username].balance -= data.amount;
            rState.bets.push({ username: u.username, numbers: data.numbers, amount: data.amount, socketId: socket.id });
            socket.emit('update_balance', users[u.username].balance);
        }
    });

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
        let myBets = rState.bets.filter(b => b.socketId === socket.id);
        if(myBets.length > 0) {
            let lastBet = myBets[myBets.length - 1];
            users[u.username].balance += lastBet.amount;
            let idx = rState.bets.lastIndexOf(lastBet);
            if(idx > -1) rState.bets.splice(idx, 1);
            socket.emit('update_balance', users[u.username].balance);
            socket.emit('bet_undone');
        }
    });

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
