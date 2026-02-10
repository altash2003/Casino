const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e8 });

const DB_FILE = 'database.json';
let users = {};
if (fs.existsSync(DB_FILE)) { try { users = JSON.parse(fs.readFileSync(DB_FILE)); } catch(e){ users = {}; } }

function saveDatabase() { fs.writeFileSync(DB_FILE, JSON.stringify(users, null, 2)); }

let activeSockets = {}; 
let chatHistory = { colorgame: [], roulette: [] };

app.use(express.static(__dirname));
app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });
app.get('/admin', (req, res) => { res.sendFile(__dirname + '/admin.html'); });

// --- HELPERS ---
function broadcastRoomList(room) {
    if(!room || room === 'lobby') return;
    let list = [];
    for(let id in activeSockets) {
        if(activeSockets[id].room === room) {
            list.push({ 
                id: id, 
                username: activeSockets[id].username,
                talking: activeSockets[id].isTalking || false
            });
        }
    }
    io.to(room).emit('room_users_update', list);
}

// --- GAME LOOPS ---
let colorState = { status: 'BETTING', timeLeft: 20 };
let rouletteState = { status: 'BETTING', timeLeft: 30 };

setInterval(() => {
    if(colorState.status === 'BETTING') {
        colorState.timeLeft--;
        if(colorState.timeLeft <= 0) {
            colorState.status = 'ROLLING';
            io.to('colorgame').emit('game_rolling');
            const C = ['RED', 'GREEN', 'BLUE', 'YELLOW', 'PINK', 'WHITE'];
            let r = [C[Math.floor(Math.random()*6)], C[Math.floor(Math.random()*6)], C[Math.floor(Math.random()*6)]];
            setTimeout(() => {
                io.to('colorgame').emit('game_result', r);
                setTimeout(() => {
                    colorState.status = 'BETTING'; colorState.timeLeft = 20;
                    io.to('colorgame').emit('game_reset');
                    io.to('colorgame').emit('timer_update', 20);
                }, 5000);
            }, 3000);
        } else io.to('colorgame').emit('timer_update', colorState.timeLeft);
    }
}, 1000);

setInterval(() => {
    if(rouletteState.status === 'BETTING') {
        rouletteState.timeLeft--;
        io.to('roulette').emit('roulette_timer', rouletteState.timeLeft);
        if(rouletteState.timeLeft <= 0) {
            rouletteState.status = 'SPINNING';
            let n = Math.floor(Math.random() * 37);
            io.to('roulette').emit('roulette_spin_start', n);
            setTimeout(() => {
                io.to('roulette').emit('roulette_result_log', n);
                processRouletteWinners(n);
                setTimeout(() => {
                    rouletteState.status = 'BETTING'; rouletteState.timeLeft = 30;
                    io.to('roulette').emit('roulette_new_round');
                }, 9000); 
            }, 9000); 
        }
    }
}, 1000);

function processRouletteWinners(n) {
    io.to('roulette').emit('roulette_win', { number: n, amount: 0 }); 
}

io.on('connection', (socket) => {
    socket.on('login', (d) => {
        if(users[d.username] && users[d.username].password === d.password) {
            joinRoom(socket, d.username, 'lobby');
            socket.emit('login_success', { username: d.username, balance: users[d.username].balance });
        } else socket.emit('login_error', "Invalid");
    });
    socket.on('register', (d) => {
        if(!users[d.username]) {
            users[d.username] = { password: d.password, balance: 1000 };
            saveDatabase();
            joinRoom(socket, d.username, 'lobby');
            socket.emit('login_success', { username: d.username, balance: 1000 });
        } else socket.emit('login_error', "Taken");
    });
    
    socket.on('switch_room', (r) => { if(activeSockets[socket.id]) joinRoom(socket, activeSockets[socket.id].username, r); });
    
    socket.on('voice_data', (b) => socket.to(activeSockets[socket.id]?.room).emit('voice_receive', {id:socket.id, audio:b}));
    
    socket.on('voice_status', (t) => {
        if(activeSockets[socket.id]) {
            activeSockets[socket.id].isTalking = t;
            io.to(activeSockets[socket.id].room).emit('player_voice_update', {id:socket.id, talking:t});
        }
    });

    socket.on('chat_msg', (d) => io.to(d.room).emit('chat_broadcast', {type:'public', user:activeSockets[socket.id].username, msg:d.msg}));
    socket.on('support_msg', (d) => socket.emit('chat_broadcast', {type:'support_sent', user:activeSockets[socket.id].username, msg:d.msg}));
    
    socket.on('place_bet_roulette', (d) => {
        let u = activeSockets[socket.id];
        if(u && users[u.username]) {
            users[u.username].balance -= d.amount;
            socket.emit('update_balance', users[u.username].balance);
        }
    });

    socket.on('roulette_clear', () => {
        // Simple client-side clear sync
    });

    socket.on('disconnect', () => {
        if(activeSockets[socket.id]) {
            let r=activeSockets[socket.id].room; delete activeSockets[socket.id]; broadcastRoomList(r);
        }
    });
});

function joinRoom(socket, username, room) {
    if(activeSockets[socket.id]) socket.leave(activeSockets[socket.id].room);
    activeSockets[socket.id] = { username, room, isTalking: false };
    socket.join(room);
    broadcastRoomList(room);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Casino running on ${PORT}`));
