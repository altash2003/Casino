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

// --- STATE ---
let playerCounts = { lobby: 0, colorgame: 0, roulette: 0 };
let activeSockets = {}; // socket.id -> { username, room }

app.use(express.static(__dirname));

// ROUTES
app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });
app.get('/admin', (req, res) => { res.sendFile(__dirname + '/admin.html'); });

// --- GAME LOOP 1: COLOR GAME ---
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
                processColorWinners(result);
                setTimeout(() => {
                    colorState.status = 'BETTING'; colorState.timeLeft = 20; colorState.bets = [];
                    io.to('colorgame').emit('timer_update', 20);
                    io.to('colorgame').emit('game_reset');
                }, 5000);
            }, 3000);
        } else { io.to('colorgame').emit('timer_update', colorState.timeLeft); }
    }
}, 1000);

// --- GAME LOOP 2: ROULETTE ---
let rouletteState = { status: 'BETTING', timeLeft: 30, bets: [] };
setInterval(() => {
    if(rouletteState.status === 'BETTING') {
        rouletteState.timeLeft--;
        io.to('roulette').emit('roulette_timer', rouletteState.timeLeft);

        if(rouletteState.timeLeft <= 0) {
            rouletteState.status = 'SPINNING';
            let resultNum = Math.floor(Math.random() * 37);
            
            // 1. Tell clients to spin to this number
            io.to('roulette').emit('roulette_spin_start', resultNum);

            // 2. Wait for animation (approx 5-6s)
            setTimeout(() => {
                // 3. Process winners & Broadcast result for history strip
                processRouletteWinners(resultNum);
                io.to('roulette').emit('roulette_result_log', resultNum); 

                setTimeout(() => {
                    rouletteState.status = 'BETTING'; rouletteState.timeLeft = 30; rouletteState.bets = [];
                    io.to('roulette').emit('roulette_new_round');
                }, 8000); // Time for "Gathering Winners" animation
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
                io.to(bet.socketId).emit('win_notification', { total: win });
                io.to(bet.socketId).emit('update_balance', users[bet.username].balance);
            }
        }
    });
    saveDatabase();
}

function processRouletteWinners(winningNumber) {
    rouletteState.bets.forEach(bet => {
        if(bet.numbers.includes(winningNumber)) {
            // Standard Payouts
            let count = bet.numbers.length;
            let payoutMult = 0;
            if (count === 1) payoutMult = 36; // Straight
            else if (count === 2) payoutMult = 18;
            else if (count === 3) payoutMult = 12;
            else if (count === 4) payoutMult = 9;
            else if (count === 6) payoutMult = 6;
            else if (count === 12) payoutMult = 3;
            else if (count === 18) payoutMult = 2; // Even/Odd etc

            // Net win logic (Original stake is kept on table in real casino, 
            // but here we just add the total payout to balance)
            let win = bet.amount * payoutMult; 
            
            if(users[bet.username]) {
                users[bet.username].balance += win;
                logHistory(bet.username, `WIN Roulette +${win}`, users[bet.username].balance);
                
                // Send specific win signal to client for the "Mario" text
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

    socket.on('switch_room', (room) => {
        let u = activeSockets[socket.id];
        if(u) joinRoom(socket, u.username, room);
    });

    // --- GAME ACTIONS ---
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
            rouletteState.bets.push({ 
                username: u.username, 
                numbers: data.numbers, // Array of numbers covered
                amount: data.amount, 
                socketId: socket.id,
                domId: data.domId // For animation targeting
            });
            // We do NOT emit update_balance here (Client handles optimistic deduction)
        }
    });
    
    // --- ADMIN ---
    socket.on('admin_req_data', () => {
        let simpleActive = {}; for(let id in activeSockets) simpleActive[id] = activeSockets[id].username;
        socket.emit('admin_data_resp', { users: users, active: simpleActive, support: [] });
    });
    socket.on('admin_add_credits', (data) => {
        if(users[data.username]) {
            users[data.username].balance += parseInt(data.amount);
            saveDatabase();
            for(let id in activeSockets) {
                 if(activeSockets[id].username === data.username) io.to(id).emit('update_balance', users[data.username].balance);
            }
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
