const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- DATABASE ---
const DB_FILE = 'database.json';
let users = {};
if (fs.existsSync(DB_FILE)) { try { users = JSON.parse(fs.readFileSync(DB_FILE)); } catch(e){ users = {}; } }
function saveDatabase() { fs.writeFileSync(DB_FILE, JSON.stringify(users, null, 2)); }
function logHistory(username, msg, bal) {
    if(!users[username].history) users[username].history = [];
    users[username].history.unshift(`[${new Date().toLocaleTimeString()}] ${msg} | BAL: ${bal}`);
    if(users[username].history.length > 50) users[username].history.pop();
}

// --- GLOBAL STATE ---
let playerCounts = { lobby: 0, colorgame: 0, roulette: 0 };
let activeSockets = {}; // socket.id -> { username, room }
let supportHistory = [];

app.use(express.static(__dirname));

// ROUTES
app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });
app.get('/admin', (req, res) => { res.sendFile(__dirname + '/admin.html'); });

// --- GAME LOOP 1: COLOR GAME (DICE) ---
let colorState = { status: 'BETTING', timeLeft: 20, bets: [] };
setInterval(() => {
    if(colorState.status === 'BETTING') {
        colorState.timeLeft--;
        if(colorState.timeLeft <= 3) io.to('colorgame').emit('countdown_beep', colorState.timeLeft); // Matches your Color Game event
        
        if(colorState.timeLeft <= 0) {
            colorState.status = 'ROLLING';
            const COLORS = ['RED', 'GREEN', 'BLUE', 'YELLOW', 'PINK', 'WHITE'];
            let result = [COLORS[Math.floor(Math.random()*6)], COLORS[Math.floor(Math.random()*6)], COLORS[Math.floor(Math.random()*6)]];
            
            io.to('colorgame').emit('game_rolling'); // Matches your Color Game event
            
            setTimeout(() => {
                io.to('colorgame').emit('game_result', result); // Matches your Color Game event
                processColorWinners(result);
                
                setTimeout(() => {
                    colorState.status = 'BETTING'; colorState.timeLeft = 20; colorState.bets = [];
                    io.to('colorgame').emit('timer_update', 20); // Reset timer event
                    io.to('colorgame').emit('game_reset');
                }, 5000);
            }, 3000);
        } else {
            io.to('colorgame').emit('timer_update', colorState.timeLeft);
        }
    }
}, 1000);

// --- GAME LOOP 2: ROULETTE ---
let rouletteState = { status: 'BETTING', timeLeft: 30, bets: [] };
setInterval(() => {
    if(rouletteState.status === 'BETTING') {
        rouletteState.timeLeft--;
        // Use generic timer event for Roulette
        io.to('roulette').emit('roulette_timer', rouletteState.timeLeft);

        if(rouletteState.timeLeft <= 0) {
            rouletteState.status = 'SPINNING';
            let resultNum = Math.floor(Math.random() * 37);
            
            // Send result immediately for animation target
            io.to('roulette').emit('roulette_spin_start', resultNum); 

            setTimeout(() => {
                processRouletteWinners(resultNum);
                setTimeout(() => {
                    rouletteState.status = 'BETTING'; rouletteState.timeLeft = 30; rouletteState.bets = [];
                    io.to('roulette').emit('roulette_new_round');
                }, 5000); 
            }, 8000); // 8s for spin animation
        }
    }
}, 1000);

// --- WINNER LOGIC ---
function processColorWinners(result) {
    colorState.bets.forEach(bet => {
        let matches = result.filter(c => c === bet.color).length;
        if(matches > 0) {
            let mult = matches + 1; // x2, x3, x4
            let win = bet.amount * mult;
            if(users[bet.username]) {
                users[bet.username].balance += win;
                logHistory(bet.username, `WIN ColorGame +${win}`, users[bet.username].balance);
                // Send specific win format for Color Game
                io.to(bet.socketId).emit('win_notification', { total: win, details: [{color: bet.color, win: win, multiplier: mult}] });
                io.to(bet.socketId).emit('update_balance', users[bet.username].balance);
            }
        }
    });
    saveDatabase();
}

function processRouletteWinners(winningNumber) {
    rouletteState.bets.forEach(bet => {
        if(bet.numbers.includes(winningNumber)) {
            // Standard Roulette Payouts
            let count = bet.numbers.length;
            let payoutMult = 0;
            if (count === 1) payoutMult = 36;
            else if (count === 2) payoutMult = 18;
            else if (count === 3) payoutMult = 12;
            else if (count === 4) payoutMult = 9;
            else if (count === 6) payoutMult = 6;
            else if (count === 12) payoutMult = 3;
            else if (count === 18) payoutMult = 2;

            let win = bet.amount * payoutMult;
            if(users[bet.username]) {
                users[bet.username].balance += win;
                logHistory(bet.username, `WIN Roulette +${win}`, users[bet.username].balance);
                // Send specific win format for Roulette
                io.to(bet.socketId).emit('roulette_win', { amount: win, number: winningNumber });
                io.to(bet.socketId).emit('update_balance', users[bet.username].balance);
            }
        }
    });
    saveDatabase();
}

// --- SOCKET CONNECTION ---
io.on('connection', (socket) => {
    io.emit('lobby_counts', playerCounts);

    // AUTH
    socket.on('login', (data) => {
        if(users[data.username] && users[data.username].password === data.password) {
            joinRoom(socket, data.username, 'lobby');
            socket.emit('login_success', { username: data.username, balance: users[data.username].balance });
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

    // ROOM SWITCHING
    socket.on('switch_room', (roomName) => {
        let u = activeSockets[socket.id];
        if(u) joinRoom(socket, u.username, roomName);
    });

    // --- COLOR GAME BETS ---
    socket.on('place_bet', (data) => { // Uses 'place_bet' from your original file
        let u = activeSockets[socket.id];
        if(!u || colorState.status !== 'BETTING') return;
        if(users[u.username].balance >= data.amount) {
            users[u.username].balance -= data.amount;
            colorState.bets.push({ username: u.username, color: data.color, amount: data.amount, socketId: socket.id });
            // Do not emit update_balance here (optimistic UI handles it), only on win or error
        } else {
            socket.emit('bet_error', "Insufficient Funds");
        }
    });

    // --- ROULETTE BETS ---
    socket.on('place_bet_roulette', (data) => {
        let u = activeSockets[socket.id];
        if(!u || rouletteState.status !== 'BETTING') return;
        if(users[u.username].balance >= data.amount) {
            users[u.username].balance -= data.amount;
            rouletteState.bets.push({ username: u.username, numbers: data.numbers, amount: data.amount, socketId: socket.id });
        }
    });

    // --- ADMIN ACTIONS (Credits) ---
    socket.on('admin_req_data', () => {
        let simpleActive = {}; for(let id in activeSockets) simpleActive[id] = activeSockets[id].username;
        socket.emit('admin_data_resp', { users: users, active: simpleActive, support: supportHistory });
    });

    socket.on('admin_add_credits', (data) => {
        if (users[data.username]) {
            users[data.username].balance += parseInt(data.amount);
            logHistory(data.username, `ADMIN ADD +${data.amount}`, users[data.username].balance);
            saveDatabase();
            // Find player socket
            for(let id in activeSockets) {
                if(activeSockets[id].username === data.username) {
                    io.to(id).emit('update_balance', users[data.username].balance);
                    io.to(id).emit('notification', { msg: `ADMIN ADDED ${data.amount}`, duration: 3000 }); // Color game uses 'notification'
                }
            }
        }
    });
    
    // --- CHAT ---
    socket.on('chat_msg', (msg) => { // Color Game Public Chat
        let u = activeSockets[socket.id];
        if(u) io.to('colorgame').emit('chat_broadcast', { user: u.username, msg: msg, type: 'public' });
    });
    
    // Admin support msgs
    socket.on('support_msg', (msg) => {
         let u = activeSockets[socket.id];
         if(u) {
             supportHistory.push({ user: u.username, msg: msg, time: Date.now() });
             io.emit('admin_support_receive', { user: u.username, msg: msg }); // To Admin
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
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Casino running on port ${PORT}`));
