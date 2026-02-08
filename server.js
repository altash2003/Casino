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

// --- STATE ---
let playerCounts = { lobby: 0, colorgame: 0, roulette: 0 };
let activeSockets = {}; // socket.id -> { username, room }

app.use(express.static(__dirname));

// ONLY ONE ROUTE NOW
app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });

// --- COLOR GAME LOOP ---
let colorState = { status: 'BETTING', timeLeft: 20, bets: [] };
setInterval(() => {
    if(colorState.status === 'BETTING') {
        colorState.timeLeft--;
        if(colorState.timeLeft <= 3) io.to('colorgame').emit('color_countdown', colorState.timeLeft);
        if(colorState.timeLeft <= 0) {
            colorState.status = 'ROLLING';
            const COLORS = ['RED', 'GREEN', 'BLUE', 'YELLOW', 'PINK', 'WHITE'];
            let result = [COLORS[Math.floor(Math.random()*6)], COLORS[Math.floor(Math.random()*6)], COLORS[Math.floor(Math.random()*6)]];
            io.to('colorgame').emit('color_rolling');
            setTimeout(() => {
                io.to('colorgame').emit('color_result', result);
                processColorWinners(result);
                setTimeout(() => {
                    colorState.status = 'BETTING'; colorState.timeLeft = 20; colorState.bets = [];
                    io.to('colorgame').emit('color_new_round');
                }, 5000);
            }, 3000);
        } else { io.to('colorgame').emit('color_timer', colorState.timeLeft); }
    }
}, 1000);

// --- ROULETTE LOOP ---
let rouletteState = { status: 'BETTING', timeLeft: 30, bets: [] };
setInterval(() => {
    if(rouletteState.status === 'BETTING') {
        rouletteState.timeLeft--;
        if(rouletteState.timeLeft <= 5) io.to('roulette').emit('roulette_countdown', rouletteState.timeLeft);
        if(rouletteState.timeLeft <= 0) {
            rouletteState.status = 'SPINNING';
            let resultNum = Math.floor(Math.random() * 37);
            io.to('roulette').emit('roulette_spinning', resultNum);
            setTimeout(() => {
                processRouletteWinners(resultNum);
                setTimeout(() => {
                    rouletteState.status = 'BETTING'; rouletteState.timeLeft = 30; rouletteState.bets = [];
                    io.to('roulette').emit('roulette_new_round');
                }, 5000);
            }, 8000);
        } else { io.to('roulette').emit('roulette_timer', rouletteState.timeLeft); }
    }
}, 1000);

// --- WINNERS ---
function processColorWinners(result) {
    colorState.bets.forEach(bet => {
        let matches = result.filter(c => c === bet.color).length;
        if(matches > 0) {
            let win = bet.amount * (matches + 1);
            if(users[bet.username]) {
                users[bet.username].balance += win;
                io.to(bet.socketId).emit('win_notification', { game: 'Color Game', amount: win });
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
            let payoutMult = count === 1 ? 36 : count === 2 ? 18 : count === 3 ? 12 : count === 4 ? 9 : count === 6 ? 6 : count === 12 ? 3 : 2;
            let win = bet.amount * payoutMult;
            if(users[bet.username]) {
                users[bet.username].balance += win;
                io.to(bet.socketId).emit('win_notification', { game: 'Roulette', amount: win, number: winningNumber });
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

    socket.on('switch_room', (roomName) => {
        let u = activeSockets[socket.id];
        if(u) joinRoom(socket, u.username, roomName);
    });

    socket.on('place_bet_color', (data) => {
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
        if(!u || rouletteState.status !== 'BETTING') return;
        if(users[u.username].balance >= data.amount) {
            users[u.username].balance -= data.amount;
            rouletteState.bets.push({ username: u.username, numbers: data.numbers, amount: data.amount, socketId: socket.id });
            socket.emit('update_balance', users[u.username].balance);
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
    // Leave old
    if(activeSockets[socket.id]) {
        let oldRoom = activeSockets[socket.id].room;
        socket.leave(oldRoom);
        if(playerCounts[oldRoom] > 0) playerCounts[oldRoom]--;
    }
    // Join new
    activeSockets[socket.id] = { username: username, room: room };
    socket.join(room);
    if(playerCounts[room] !== undefined) playerCounts[room]++;
    
    io.emit('lobby_counts', playerCounts);
    
    // Send state
    if(room === 'colorgame') socket.emit('color_timer', colorState.timeLeft);
    if(room === 'roulette') socket.emit('roulette_timer', rouletteState.timeLeft);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Casino running on port ${PORT}`));