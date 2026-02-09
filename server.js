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
if (fs.existsSync(DB_FILE)) { try { users = JSON.parse(fs.readFileSync(DB_FILE)); } catch(e){ users = {}; } }

function saveDatabase() { fs.writeFileSync(DB_FILE, JSON.stringify(users, null, 2)); }
function logHistory(username, msg, bal) {
    if(!users[username].history) users[username].history = [];
    users[username].history.unshift(`[${new Date().toLocaleTimeString()}] ${msg} | BAL: ${bal}`);
    if(users[username].history.length > 50) users[username].history.pop();
}

let activeSockets = {}; 
let supportHistory = []; 
let playerCounts = { lobby: 0, colorgame: 0, roulette: 0 };
let chatHistory = { colorgame: [], roulette: [] };
let rouletteHistory = []; // Global server-side history for roulette

app.use(express.static(__dirname));
app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });
app.get('/admin', (req, res) => { res.sendFile(__dirname + '/admin.html'); });

// --- ROULETTE GAME LOOP (STRICT STATE MACHINE) ---
let rState = {
    phase: 'BETTING', // BETTING, SPINNING, RESULT, PAYOUT
    timeLeft: 20,
    bets: [] // { username, numbers, amount, socketId }
};

setInterval(() => {
    // 1. BETTING PHASE
    if(rState.phase === 'BETTING') {
        rState.timeLeft--;
        io.to('roulette').emit('roulette_timer', rState.timeLeft); // Sync Timer

        // Countdown Ticks (3, 2, 1) handled by client based on this number

        if(rState.timeLeft <= 0) {
            // TRANSITION TO SPINNING
            rState.phase = 'SPINNING';
            io.to('roulette').emit('roulette_state', 'LOCKED'); // Lock inputs immediately
            
            // Generate Result
            let resultNum = Math.floor(Math.random() * 37);
            
            // Log to History
            rouletteHistory.unshift(resultNum);
            if(rouletteHistory.length > 23) rouletteHistory.pop();

            // Broadcast Spin Target
            io.to('roulette').emit('roulette_spin', resultNum);

            // PROCESS WINNERS (Internal Calculation)
            let roundWinners = [];
            rState.bets.forEach(bet => {
                if(bet.numbers.includes(resultNum)) {
                    // Payout Logic
                    let count = bet.numbers.length;
                    let payoutMult = 0;
                    if (count === 1) payoutMult = 36;
                    else if (count === 2) payoutMult = 18;
                    else if (count === 3) payoutMult = 12;
                    else if (count === 4) payoutMult = 9;
                    else if (count === 6) payoutMult = 6;
                    else if (count === 12) payoutMult = 3;
                    else if (count === 18) payoutMult = 2;
                    
                    let winAmount = bet.amount * payoutMult;
                    
                    // Update User DB
                    if(users[bet.username]) {
                        users[bet.username].balance += winAmount;
                        roundWinners.push({ socketId: bet.socketId, win: winAmount, num: resultNum });
                        logHistory(bet.username, `WIN Roulette +${winAmount}`, users[bet.username].balance);
                    }
                }
            });
            saveDatabase();

            // WAIT FOR ANIMATIONS TO FINISH ON CLIENT
            // Timeline:
            // 0s: Start Spin (Duration 4s)
            // 4s: Wheel Stop & Hold (Duration 1.5s)
            // 5.5s: Wheel Hide, Reveal Table (Duration 1.5s)
            // 7s: Start Gather Anim (Duration 2s)
            // 9s: Start Payout Coin Anim (Duration 1.5s)
            // 10.5s: Update Balances & Reset
            
            setTimeout(() => {
                // SEND PAYOUTS (Triggers Coin Anim on Client)
                roundWinners.forEach(w => {
                    io.to(w.socketId).emit('roulette_payout', { amount: w.win, number: resultNum, balance: users[activeSockets[w.socketId]?.username]?.balance });
                });
                
                // Update Histories for everyone
                io.to('roulette').emit('roulette_history_update', rouletteHistory);

                // RESET ROUND
                setTimeout(() => {
                    rState.phase = 'BETTING';
                    rState.timeLeft = 20;
                    rState.bets = [];
                    io.to('roulette').emit('roulette_state', 'NEW_ROUND');
                }, 1500); // Wait for coin anim to finish

            }, 9000); // 4 + 1.5 + 1.5 + 2 = 9s
        }
    }
}, 1000);


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
                // Process Color Winners
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
            // Send initial history
            socket.emit('roulette_history_update', rouletteHistory);
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
            let msgObj = { type: 'public', user: u.username, msg: data.msg, room: data.room };
            if(chatHistory[data.room]) {
                chatHistory[data.room].push(msgObj);
                if(chatHistory[data.room].length > 20) chatHistory[data.room].shift();
            }
            io.to(data.room).emit('chat_broadcast', msgObj);
        }
    });

    socket.on('place_bet', (data) => { // Color Game
        let u = activeSockets[socket.id];
        if(!u || colorState.status !== 'BETTING') return;
        if(users[u.username].balance >= data.amount) {
            users[u.username].balance -= data.amount;
            colorState.bets.push({ username: u.username, color: data.color, amount: data.amount, socketId: socket.id });
        }
    });

    socket.on('place_bet_roulette', (data) => {
        let u = activeSockets[socket.id];
        // Only accept if betting phase
        if(!u || rState.phase !== 'BETTING') return; 
        
        if(users[u.username].balance >= data.amount) {
            users[u.username].balance -= data.amount;
            rState.bets.push({ username: u.username, numbers: data.numbers, amount: data.amount, socketId: socket.id });
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
    io.emit('lobby_counts', playerCounts);
    if(chatHistory[room]) { socket.emit('chat_history', chatHistory[room]); }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Casino running on port ${PORT}`));
