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

if (fs.existsSync(DB_FILE)) { 
    try { users = JSON.parse(fs.readFileSync(DB_FILE)); } catch(e){ users = {}; } 
} else { saveDatabase(); }

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
//  ROBUST GAME STATE MACHINES
// ==========================================

// --- ROULETTE STATE ---
let rGame = {
    phase: 'BETTING', // BETTING, SPINNING, RESULT, SHOWDOWN
    timer: 20,        // Countdown in seconds
    bets: [],
    result: 0
};

// --- COLOR GAME STATE ---
let cGame = {
    phase: 'BETTING', // BETTING, ROLLING, RESULT
    timer: 20,
    bets: [],
    result: ['WHITE', 'WHITE', 'WHITE']
};

// --- MASTER TICK (1 Second Heartbeat) ---
setInterval(() => {
    tickRoulette();
    tickColorGame();
}, 1000);


// === ROULETTE LOGIC ===
function tickRoulette() {
    rGame.timer--;

    // Broadcast State Every Second
    io.to('roulette').emit('roulette_state', {
        phase: rGame.phase,
        time: rGame.timer,
        result: rGame.result // Send result only needed in result phase, but safe to send always
    });

    if (rGame.timer <= 0) {
        // STATE TRANSITIONS
        if (rGame.phase === 'BETTING') {
            // Start Spinning
            rGame.phase = 'SPINNING';
            rGame.timer = 4; // 4s Spin duration
            rGame.result = Math.floor(Math.random() * 37);
            
            // Add to history
            rouletteHistory.unshift(rGame.result);
            if(rouletteHistory.length > 23) rouletteHistory.pop();
            io.to('roulette').emit('roulette_history', rouletteHistory);

        } else if (rGame.phase === 'SPINNING') {
            // Spin done, Show Result on Wheel (Hold)
            rGame.phase = 'RESULT';
            rGame.timer = 2; // Hold wheel result for 2s

        } else if (rGame.phase === 'RESULT') {
            // Hide Wheel, Show Table & Gather Animations
            rGame.phase = 'SHOWDOWN';
            rGame.timer = 5; // 5s for Gathering + Coin Animation
            processRoulettePayouts(rGame.result);

        } else if (rGame.phase === 'SHOWDOWN') {
            // Reset to Betting
            rGame.phase = 'BETTING';
            rGame.timer = 20;
            rGame.bets = []; // Clear Bets
            io.to('roulette').emit('roulette_reset');
        }
    }
}

function processRoulettePayouts(winningNumber) {
    let roundWinners = [];
    rGame.bets.forEach(bet => {
        if(bet.numbers.includes(winningNumber)) {
            let count = bet.numbers.length;
            let payoutMult = (count===1)?36 : (count===2)?18 : (count===3)?12 : (count===4)?9 : (count===6)?6 : (count===12)?3 : 2;
            let winAmount = bet.amount * payoutMult;
            
            if(users[bet.username]) {
                users[bet.username].balance += winAmount;
                // Emit individual win event to player
                io.to(bet.socketId).emit('roulette_win_data', { 
                    amount: winAmount, 
                    balance: users[bet.username].balance, 
                    number: winningNumber 
                });
            }
        }
    });
    saveDatabase();
}


// === COLOR GAME LOGIC ===
function tickColorGame() {
    cGame.timer--;
    
    // Broadcast State
    io.to('colorgame').emit('color_state', {
        phase: cGame.phase,
        time: cGame.timer,
        result: cGame.result
    });

    if(cGame.timer <= 3 && cGame.phase === 'BETTING') {
        io.to('colorgame').emit('countdown_beep', cGame.timer);
    }

    if (cGame.timer <= 0) {
        if (cGame.phase === 'BETTING') {
            // Start Rolling
            cGame.phase = 'ROLLING';
            cGame.timer = 4; // 4s Rolling animation
            const COLORS = ['RED', 'GREEN', 'BLUE', 'YELLOW', 'PINK', 'WHITE'];
            cGame.result = [
                COLORS[Math.floor(Math.random()*6)], 
                COLORS[Math.floor(Math.random()*6)], 
                COLORS[Math.floor(Math.random()*6)]
            ];

        } else if (cGame.phase === 'ROLLING') {
            // Show Result
            cGame.phase = 'RESULT';
            cGame.timer = 5; // 5s to show winners
            processColorPayouts(cGame.result);

        } else if (cGame.phase === 'RESULT') {
            // Reset
            cGame.phase = 'BETTING';
            cGame.timer = 20;
            cGame.bets = [];
        }
    }
}

function processColorPayouts(result) {
    cGame.bets.forEach(bet => {
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
}

// --- SOCKETS ---
io.on('connection', (socket) => {
    io.emit('lobby_counts', playerCounts);

    socket.on('login', (data) => {
        if(users[data.username] && users[data.username].password === data.password) {
            joinRoom(socket, data.username, 'lobby');
            socket.emit('login_success', { username: data.username, balance: users[data.username].balance });
            // Sync immediately on login
            socket.emit('roulette_history', rouletteHistory);
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

    // --- BETTING HANDLERS ---
    socket.on('place_bet', (data) => { // Color Game
        let u = activeSockets[socket.id];
        if(!u || cGame.phase !== 'BETTING') return;
        if(users[u.username].balance >= data.amount) {
            users[u.username].balance -= data.amount;
            cGame.bets.push({ username: u.username, color: data.color, amount: data.amount, socketId: socket.id });
            socket.emit('update_balance', users[u.username].balance);
        }
    });

    socket.on('place_bet_roulette', (data) => {
        let u = activeSockets[socket.id];
        if(!u || rGame.phase !== 'BETTING') return; 
        if(users[u.username].balance >= data.amount) {
            users[u.username].balance -= data.amount;
            rGame.bets.push({ username: u.username, numbers: data.numbers, amount: data.amount, socketId: socket.id });
            socket.emit('update_balance', users[u.username].balance);
        }
    });

    socket.on('roulette_clear', () => {
        let u = activeSockets[socket.id];
        if(!u || rGame.phase !== 'BETTING') return;
        let userBets = rGame.bets.filter(b => b.socketId === socket.id);
        if(userBets.length > 0) {
            let refund = userBets.reduce((a,b) => a + b.amount, 0);
            users[u.username].balance += refund;
            rGame.bets = rGame.bets.filter(b => b.socketId !== socket.id);
            socket.emit('update_balance', users[u.username].balance);
            socket.emit('bets_cleared');
        }
    });

    socket.on('roulette_undo', () => {
        let u = activeSockets[socket.id];
        if(!u || rGame.phase !== 'BETTING') return;
        let myBets = rGame.bets.filter(b => b.socketId === socket.id);
        if(myBets.length > 0) {
            let lastBet = myBets[myBets.length - 1];
            users[u.username].balance += lastBet.amount;
            let idx = rGame.bets.lastIndexOf(lastBet);
            if(idx > -1) rGame.bets.splice(idx, 1);
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
    // Immediate state sync
    if(room === 'roulette') {
        socket.emit('roulette_state', { phase: rGame.phase, time: rGame.timer, result: rGame.result });
    } else if (room === 'colorgame') {
        socket.emit('color_state', { phase: cGame.phase, time: cGame.timer, result: cGame.result });
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Casino Running on Port ${PORT}`));
