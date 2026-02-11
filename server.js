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
app.use(express.static(__dirname));
app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });

function broadcastRoomList(room) {
    if(!room || room === 'lobby') return;
    let list = [];
    for(let id in activeSockets) {
        if(activeSockets[id].room === room) {
            list.push({ id: id, username: activeSockets[id].username, talking: activeSockets[id].isTalking||false });
        }
    }
    io.to(room).emit('room_users_update', list);
}

// --- GAME STATE ---
let colorState = { status: 'BETTING', timeLeft: 20 };
let rouletteState = { status: 'BETTING', timeLeft: 30, bets: [] };

// Roulette Loop
setInterval(() => {
    if(rouletteState.status === 'BETTING') {
        rouletteState.timeLeft--;
        io.to('roulette').emit('roulette_timer', rouletteState.timeLeft);
        
        if(rouletteState.timeLeft <= 0) {
            rouletteState.status = 'LOCKED';
            io.to('roulette').emit('roulette_state', 'LOCKED');
            
            // 0.5s Rest
            setTimeout(() => {
                io.to('roulette').emit('roulette_state', 'CLOSED');
                
                // 0.5s Lock -> Spin
                setTimeout(() => {
                    rouletteState.status = 'SPINNING';
                    let n = Math.floor(Math.random() * 37);
                    io.to('roulette').emit('roulette_spin_start', n);
                    
                    // 4s Spin + 5s Animations + 1s Reset
                    setTimeout(() => {
                        io.to('roulette').emit('roulette_result_log', n);
                        processRouletteWinners(n);
                        
                        setTimeout(() => {
                            rouletteState.status = 'BETTING'; rouletteState.timeLeft = 30; rouletteState.bets = [];
                            io.to('roulette').emit('roulette_new_round');
                        }, 5000); 
                    }, 4500); 
                }, 500);
            }, 500);
        }
    }
}, 1000);

// Color Game Loop
setInterval(() => {
    if(colorState.status === 'BETTING') {
        colorState.timeLeft--;
        if(colorState.timeLeft <= 0) {
            colorState.status = 'ROLLING';
            io.to('colorgame').emit('game_rolling');
            setTimeout(() => {
                let r = ['RED','RED','RED']; 
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

function processRouletteWinners(n) {
    let totalWins = {};
    rouletteState.bets.forEach(b => {
        if(b.numbers.includes(n)) {
            // Real Payouts
            let count = b.numbers.length;
            let mult = 0;
            if(count === 1) mult = 35;       // Straight
            else if(count === 2) mult = 17;  // Split
            else if(count === 3) mult = 11;  // Street
            else if(count === 4) mult = 8;   // Corner
            else if(count === 6) mult = 5;   // Six Line
            else if(count === 12) mult = 2;  // Dozens/Columns
            else if(count === 18) mult = 1;  // Even/Odd/Red/Black
            
            // Total return = Bet + (Bet * Mult)
            let winAmount = b.amount + (b.amount * mult);
            
            if(!totalWins[b.socketId]) totalWins[b.socketId] = 0;
            totalWins[b.socketId] += winAmount;
            
            if(users[b.username]) users[b.username].balance += winAmount;
        }
    });
    saveDatabase();
    
    // Broadcast updates
    for(let sid in totalWins) {
        io.to(sid).emit('update_balance', users[activeSockets[sid]?.username]?.balance || 0);
        io.to(sid).emit('my_win_total', totalWins[sid]);
    }
    io.to('roulette').emit('roulette_win', { number: n });
}

io.on('connection', (socket) => {
    socket.on('login', (d) => {
        if(users[d.username] && users[d.username].password === d.password) {
            joinRoom(socket, d.username, 'lobby');
            socket.emit('login_success', { username: d.username, balance: users[d.username].balance });
        } else socket.emit('login_error', "Invalid Credentials");
    });
    socket.on('register', (d) => {
        if(!users[d.username]) { users[d.username] = { password: d.password, balance: 1000 }; saveDatabase(); joinRoom(socket, d.username, 'lobby'); socket.emit('login_success', { username: d.username, balance: 1000 }); } 
        else socket.emit('login_error', "Username Taken");
    });
    socket.on('switch_room', (r) => { if(activeSockets[socket.id]) joinRoom(socket, activeSockets[socket.id].username, r); });
    socket.on('voice_data', (b) => socket.to(activeSockets[socket.id]?.room).emit('voice_receive', {id:socket.id, audio:b}));
    socket.on('voice_status', (t) => { if(activeSockets[socket.id]) { activeSockets[socket.id].isTalking = t; io.to(activeSockets[socket.id].room).emit('player_voice_update', {id:socket.id, talking:t}); } });
    socket.on('chat_msg', (d) => io.to(d.room).emit('chat_broadcast', {type:'public', user:activeSockets[socket.id].username, msg:d.msg}));

    socket.on('place_bet_roulette', (d) => {
        let u = activeSockets[socket.id];
        // d.amount is negative for refund
        if(u && users[u.username]) {
            if(d.amount > 0 && users[u.username].balance < d.amount) return;
            users[u.username].balance -= d.amount; // Subtract bet OR Add negative(refund)
            
            if(d.amount > 0) rouletteState.bets.push({ socketId: socket.id, username: u.username, numbers: d.numbers, amount: d.amount });
            // Note: Complex unstacking logic for undo on server side omitted for brevity, but balance is refunded
            socket.emit('update_balance', users[u.username].balance);
        }
    });

    socket.on('roulette_clear', () => {
        let u = activeSockets[socket.id];
        if(!u) return;
        // Refund all bets for this user
        let myBets = rouletteState.bets.filter(b => b.socketId === socket.id);
        let total = myBets.reduce((a,b)=>a+b.amount,0);
        if(total > 0 && users[u.username]) {
            users[u.username].balance += total;
            rouletteState.bets = rouletteState.bets.filter(b => b.socketId !== socket.id);
            socket.emit('update_balance', users[u.username].balance);
        }
        socket.emit('bets_cleared');
    });

    socket.on('disconnect', () => {
        if(activeSockets[socket.id]) { let r=activeSockets[socket.id].room; delete activeSockets[socket.id]; broadcastRoomList(r); }
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
