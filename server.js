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
if (fs.existsSync(DB_FILE)) { 
    try { users = JSON.parse(fs.readFileSync(DB_FILE)); } catch(e){ users = {}; }
}

function saveDatabase() { fs.writeFileSync(DB_FILE, JSON.stringify(users, null, 2)); }
function logHistory(username, msg, bal) {
    if(!users[username].history) users[username].history = [];
    users[username].history.unshift(`[${new Date().toLocaleTimeString()}] ${msg} | BAL: ${bal}`);
    if(users[username].history.length > 50) users[username].history.pop();
}

// --- GLOBAL STATE ---
let activeSockets = {}; // socket.id -> { username, room }
let supportHistory = []; 
let playerCounts = { lobby: 0, colorgame: 0, roulette: 0 };

app.use(express.static(__dirname));

// ROUTES
app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });
app.get('/admin', (req, res) => { res.sendFile(__dirname + '/admin.html'); });

// --- GAME LOOP 1: COLOR GAME ---
let colorState = { status: 'BETTING', timeLeft: 20, bets: [] };
setInterval(() => {
    if(colorState.status === 'BETTING') {
        colorState.timeLeft--;
        if(colorState.timeLeft <= 3) io.emit('countdown_beep', colorState.timeLeft);
        
        if(colorState.timeLeft <= 0) {
            colorState.status = 'ROLLING';
            const COLORS = ['RED', 'GREEN', 'BLUE', 'YELLOW', 'PINK', 'WHITE'];
            let result = [COLORS[Math.floor(Math.random()*6)], COLORS[Math.floor(Math.random()*6)], COLORS[Math.floor(Math.random()*6)]];
            
            io.emit('game_rolling');
            
            setTimeout(() => {
                io.emit('game_result', result);
                processColorWinners(result);
                
                setTimeout(() => {
                    colorState.status = 'BETTING'; colorState.timeLeft = 20; colorState.bets = [];
                    io.emit('timer_update', 20);
                    io.emit('game_reset');
                }, 5000);
            }, 3000);
        } else {
            io.emit('timer_update', colorState.timeLeft);
        }
    }
}, 1000);

// --- GAME LOOP 2: ROULETTE ---
let rouletteState = { status: 'BETTING', timeLeft: 30, bets: [] };
setInterval(() => {
    if(rouletteState.status === 'BETTING') {
        rouletteState.timeLeft--;
        io.emit('roulette_timer', rouletteState.timeLeft);

        if(rouletteState.timeLeft <= 0) {
            rouletteState.status = 'SPINNING';
            let resultNum = Math.floor(Math.random() * 37);
            
            io.emit('roulette_spin_start', resultNum);

            setTimeout(() => {
                io.emit('roulette_result_log', resultNum);
                processRouletteWinners(resultNum);
                setTimeout(() => {
                    rouletteState.status = 'BETTING'; rouletteState.timeLeft = 30; rouletteState.bets = [];
                    io.emit('roulette_new_round');
                }, 5000);
            }, 6000);
        }
    }
}, 1000);

// --- WINNER LOGIC ---
function processColorWinners(result) {
    colorState.bets.forEach(bet => {
        let matches = result.filter(c => c === bet.color).length;
        if(matches > 0) {
            let mult = matches + 1;
            let win = bet.amount * mult;
            if(users[bet.username]) {
                users[bet.username].balance += win;
                logHistory(bet.username, `WIN ColorGame +${win}`, users[bet.username].balance);
                io.to(bet.socketId).emit('win_notification', { game: 'COLOR GAME', amount: win });
                io.to(bet.socketId).emit('update_balance', users[bet.username].balance);
            }
        }
    });
    saveDatabase();
}

function processRouletteWinners(winningNumber) {
    rouletteState.bets.forEach(bet => {
        if(bet.numbers.includes(winningNumber)) {
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
                io.to(bet.socketId).emit('roulette_win', { amount: win, number: winningNumber });
                io.to(bet.socketId).emit('update_balance', users[bet.username].balance);
            }
        }
    });
    saveDatabase();
}

// --- SOCKETS ---
io.on('connection', (socket) => {
    io.emit('lobby_counts', playerCounts);

    // AUTH
    socket.on('login', (data) => {
        if(users[data.username] && users[data.username].password === data.password) {
            joinRoom(socket, data.username, 'lobby');
            socket.emit('login_success', { username: data.username, balance: users[data.username].balance, history: users[data.username].history || [] });
        } else { socket.emit('login_error', "Invalid Credentials"); }
    });

    socket.on('register', (data) => {
        if(!users[data.username]) {
            users[data.username] = { password: data.password, balance: 1000, history: [] };
            saveDatabase();
            joinRoom(socket, data.username, 'lobby');
            socket.emit('login_success', { username: data.username, balance: 1000, history: [] });
        } else { socket.emit('login_error', "Username taken"); }
    });

    socket.on('switch_room', (room) => {
        let u = activeSockets[socket.id];
        if(u) joinRoom(socket, u.username, room);
    });

    // --- CHAT & SUPPORT (From your Color Game file) ---
    socket.on('chat_msg', (msg) => {
        let u = activeSockets[socket.id];
        if(u) io.emit('chat_broadcast', { type: 'public', user: u.username, msg: msg });
    });
    
    socket.on('support_msg', (msg) => {
        let u = activeSockets[socket.id];
        if(u) {
            let log = { user: u.username, msg: msg, time: Date.now() };
            supportHistory.push(log);
            // Send to Admin
            io.emit('admin_support_receive', log); 
            // Send back to user so they see it
            socket.emit('chat_broadcast', { type: 'support_sent', msg: msg });
        }
    });

    // --- ADMIN ACTIONS (From your Server file) ---
    socket.on('admin_reply_support', (data) => {
        // Find user socket
        for(let id in activeSockets) {
            if(activeSockets[id].username === data.targetUser) {
                io.to(id).emit('chat_broadcast', { type: 'support_reply', msg: data.msg });
            }
        }
    });

    socket.on('admin_add_credits', (data) => {
        if(users[data.username]) {
            users[data.username].balance += parseInt(data.amount);
            logHistory(data.username, `ADMIN ADD +${data.amount}`, users[data.username].balance);
            saveDatabase();
            refreshUser(data.username);
        }
    });

    socket.on('admin_add_all', (amount) => {
        let amt = parseInt(amount);
        for(let id in activeSockets) {
            let name = activeSockets[id].username;
            if(users[name]) {
                users[name].balance += amt;
                logHistory(name, `ADMIN GIFT +${amt}`, users[name].balance);
                io.to(id).emit('notification', { msg: `GIFT! +${amt} CREDITS`, duration: 3000 });
                io.to(id).emit('update_balance', users[name].balance);
            }
        }
        saveDatabase();
    });

    socket.on('admin_req_data', () => {
        let simpleActive = {}; for(let id in activeSockets) simpleActive[id] = activeSockets[id].username;
        socket.emit('admin_data_resp', { users: users, active: simpleActive, support: supportHistory });
    });

    // --- BETTING ---
    socket.on('place_bet', (data) => { // Color Game
        let u = activeSockets[socket.id];
        if(!u || colorState.status !== 'BETTING') return;
        if(users[u.username].balance >= data.amount) {
            users[u.username].balance -= data.amount;
            colorState.bets.push({ username: u.username, color: data.color, amount: data.amount, socketId: socket.id });
        }
    });

    socket.on('place_bet_roulette', (data) => { // Roulette
        let u = activeSockets[socket.id];
        if(!u || rouletteState.status !== 'BETTING') return;
        if(users[u.username].balance >= data.amount) {
            users[u.username].balance -= data.amount;
            rouletteState.bets.push({ username: u.username, numbers: data.numbers, amount: data.amount, socketId: socket.id });
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

function refreshUser(username) {
    for(let id in activeSockets) {
        if(activeSockets[id].username === username) io.to(id).emit('update_balance', users[username].balance);
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Casino running on port ${PORT}`));
