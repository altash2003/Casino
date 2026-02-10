const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const fs = require('fs');
const bcrypt = require('bcryptjs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json()); 
app.use(express.static(__dirname));

// --- DATABASE ---
const DB_FILE = 'database.json';
let dbData = { users: {}, admins: {} };

function loadDatabase() {
    if (fs.existsSync(DB_FILE)) {
        try {
            const raw = fs.readFileSync(DB_FILE);
            dbData = JSON.parse(raw);
            if (!dbData.admins) dbData.admins = {}; 
            if (!dbData.users) dbData.users = {}; 
        } catch (e) { console.error("DB Load Error:", e); }
    }
}
function saveDatabase() { fs.writeFileSync(DB_FILE, JSON.stringify(dbData, null, 2)); }
loadDatabase();

if (Object.keys(dbData.admins).length === 0) {
    const hash = bcrypt.hashSync("admin123", 10); 
    dbData.admins["admin"] = { password: hash, role: "ADMIN", created: Date.now() };
    saveDatabase();
}

// --- STATE ---
// activeSockets: { socketId: { username, role, isSpeaking } }
let activeSockets = {}; 

const R_WHEEL = ["0","28","9","26","30","11","7","20","32","17","5","22","34","15","3","24","36","13","1","00","27","10","25","29","12","8","19","31","18","6","21","33","16","4","23","35","14","2"];

io.on('connection', (socket) => {
    
    socket.on('login', (data) => {
        const { username, password } = data;
        if (!dbData.users[username]) {
            dbData.users[username] = { password: password, balance: 1000 };
            saveDatabase();
        }
        if (dbData.users[username].password === password) {
            // Save user state with isSpeaking: false initially
            activeSockets[socket.id] = { username, role: 'PLAYER', isSpeaking: false };
            
            socket.emit('login_success', { 
                username, 
                balance: dbData.users[username].balance,
                mySocketId: socket.id 
            });
            
            io.emit('player_list_update', Object.values(activeSockets));
            
            // Send existing users to the new guy for WebRTC
            const others = Object.keys(activeSockets).filter(id => id !== socket.id);
            socket.emit('existing_users', others);
        } else {
            socket.emit('login_error', 'Invalid Credentials');
        }
    });

    // --- GAME LOGIC ---
    socket.on('roulette_spin', (bets) => {
        const user = activeSockets[socket.id];
        if (!user) return;
        
        let totalBet = 0;
        bets.forEach(b => totalBet += b.amount);

        if (dbData.users[user.username].balance < totalBet) return;
        
        dbData.users[user.username].balance -= totalBet;
        const resultIndex = Math.floor(Math.random() * R_WHEEL.length);
        const resultVal = R_WHEEL[resultIndex];
        const nVal = parseInt(resultVal);
        
        let totalWin = 0;
        bets.forEach(bet => {
            let won = false; let multiplier = 0;
            if (bet.numbers.includes(nVal)) {
                if (bet.numbers.length === 1) multiplier = 35;
                else if (bet.numbers.length === 12) multiplier = 2;
                else if (bet.numbers.length === 18) multiplier = 1;
                else multiplier = Math.floor(35 / bet.numbers.length);
                won = true; 
            }
            if (won) totalWin += bet.amount * (multiplier + 1);
        });

        dbData.users[user.username].balance += totalWin;
        saveDatabase();
        socket.emit('roulette_result', { result: resultVal, balance: dbData.users[user.username].balance, win: totalWin });
    });

    // --- VOICE & LIST LOGIC ---
    
    // 1. WebRTC Signaling (Relay offers/answers between clients)
    socket.on('voice_signal', (payload) => {
        io.to(payload.target).emit('voice_signal', {
            signal: payload.signal,
            callerID: socket.id
        });
    });

    // 2. Speaking Status Update
    socket.on('speaking_status', (isSpeaking) => {
        if(activeSockets[socket.id]) {
            activeSockets[socket.id].isSpeaking = isSpeaking;
            // Broadcast the FULL list again so everyone resorts their list
            // We attach the socketID so clients can map it
            const listWithIds = Object.entries(activeSockets).map(([id, data]) => ({
                id: id,
                username: data.username,
                isSpeaking: data.isSpeaking
            }));
            io.emit('player_list_update', listWithIds);
        }
    });

    socket.on('disconnect', () => {
        const user = activeSockets[socket.id];
        delete activeSockets[socket.id];
        // Send updated list
        const listWithIds = Object.entries(activeSockets).map(([id, data]) => ({
            id: id,
            username: data.username,
            isSpeaking: data.isSpeaking
        }));
        io.emit('player_list_update', listWithIds);
        io.emit('user_left', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Casino running on port ${PORT}`));
