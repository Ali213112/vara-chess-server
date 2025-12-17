const express = require("express");
const http = require("http");
const cors = require("cors");
const mongoose = require("mongoose");
const path = require("path");

// Initialize Express
const app = express();
const server = http.createServer(app);

// Socket.io with CORS for production
const io = require("socket.io")(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// MongoDB Connection
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/varachess";

mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
  .then(() => console.log("✅ MongoDB Connected"))
  .catch(err => console.error("❌ MongoDB Error:", err));

// Models
const UserSchema = new mongoose.Schema({
  walletAddress: { type: String, unique: true, required: true },
  username: { type: String, default: "Player" },
  wins: { type: Number, default: 0 },
  losses: { type: Number, default: 0 },
  draws: { type: Number, default: 0 },
  rating: { type: Number, default: 1000 },
  gamesPlayed: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  lastSeen: { type: Date, default: Date.now }
});

const GameSchema = new mongoose.Schema({
  roomId: { type: String, required: true },
  player1: { type: String }, // wallet address
  player2: { type: String },
  winner: { type: String },
  moves: [{ from: String, to: String, timestamp: Date }],
  status: { type: String, enum: ['waiting', 'playing', 'finished'], default: 'waiting' },
  gameType: { type: String, enum: ['random', 'friend'], default: 'random' },
  createdAt: { type: Date, default: Date.now },
  finishedAt: { type: Date }
});

const User = mongoose.model("User", UserSchema);
const Game = mongoose.model("Game", GameSchema);

// In-memory game state
const games = {};
const matchmakingQueue = [];
let onlineUsers = 0;

// Routes
const routes = require("./routes/token");
app.use(routes);

// API Routes
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", online: onlineUsers });
});

// Get or create user
app.post("/api/user", async (req, res) => {
  try {
    const { walletAddress, username } = req.body;
    let user = await User.findOne({ walletAddress });

    if (!user) {
      user = new User({ walletAddress, username: username || "Player" });
      await user.save();
    } else {
      user.lastSeen = new Date();
      if (username) user.username = username;
      await user.save();
    }

    res.json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get leaderboard
app.get("/api/leaderboard", async (req, res) => {
  try {
    const users = await User.find({ gamesPlayed: { $gt: 0 } })
      .sort({ rating: -1 })
      .limit(100)
      .select("username walletAddress wins losses rating gamesPlayed");
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get user stats
app.get("/api/user/:wallet", async (req, res) => {
  try {
    const user = await User.findOne({ walletAddress: req.params.wallet });
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get game history
app.get("/api/games/:wallet", async (req, res) => {
  try {
    const games = await Game.find({
      $or: [
        { player1: req.params.wallet },
        { player2: req.params.wallet }
      ],
      status: 'finished'
    })
      .sort({ finishedAt: -1 })
      .limit(50);
    res.json(games);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Socket.io Events
io.on("connection", (socket) => {
  console.log("🎮 Player connected:", socket.id);
  onlineUsers++;
  io.emit("online-count", onlineUsers);

  // Register player
  socket.on("register", async (data) => {
    socket.walletAddress = data.wallet;
    socket.username = data.username || "Player";
    console.log(`👤 ${socket.username} registered`);
  });

  // Random Matchmaking
  socket.on("find-match", async (data) => {
    socket.walletAddress = data.wallet;
    socket.username = data.username || "Player";

    // Check if already in queue
    const existingIndex = matchmakingQueue.findIndex(s => s.walletAddress === socket.walletAddress);
    if (existingIndex !== -1) {
      matchmakingQueue.splice(existingIndex, 1);
    }

    // Find opponent
    if (matchmakingQueue.length > 0) {
      const opponent = matchmakingQueue.shift();

      // Create room
      const roomId = generateRoomId();

      games[roomId] = {
        roomId,
        player1: { socket: opponent, wallet: opponent.walletAddress, username: opponent.username, side: 'white' },
        player2: { socket: socket, wallet: socket.walletAddress, username: socket.username, side: 'black' },
        status: 'playing',
        gameType: 'random',
        moves: [],
        createdAt: new Date()
      };

      // Save to database
      const gameRecord = new Game({
        roomId,
        player1: opponent.walletAddress,
        player2: socket.walletAddress,
        status: 'playing',
        gameType: 'random'
      });
      await gameRecord.save();

      // Join room
      opponent.join(roomId);
      socket.join(roomId);
      opponent.roomId = roomId;
      socket.roomId = roomId;

      // Notify both players
      opponent.emit("match-found", {
        roomId,
        side: 'white',
        opponent: { username: socket.username, wallet: socket.walletAddress }
      });

      socket.emit("match-found", {
        roomId,
        side: 'black',
        opponent: { username: opponent.username, wallet: opponent.walletAddress }
      });

      console.log(`⚔️ Match created: ${opponent.username} vs ${socket.username}`);
    } else {
      matchmakingQueue.push(socket);
      socket.emit("waiting-for-match");
      console.log(`⏳ ${socket.username} waiting for match...`);
    }
  });

  // Cancel matchmaking
  socket.on("cancel-match", () => {
    const index = matchmakingQueue.findIndex(s => s.id === socket.id);
    if (index !== -1) {
      matchmakingQueue.splice(index, 1);
      socket.emit("match-cancelled");
    }
  });

  // Create private room (play with friend)
  socket.on("create-room", async (data) => {
    const roomId = generateRoomId();
    socket.walletAddress = data.wallet;
    socket.username = data.username || "Player";

    games[roomId] = {
      roomId,
      player1: { socket, wallet: socket.walletAddress, username: socket.username, side: 'white' },
      player2: null,
      status: 'waiting',
      gameType: 'friend',
      moves: [],
      createdAt: new Date()
    };

    socket.join(roomId);
    socket.roomId = roomId;

    socket.emit("room-created", { roomId, side: 'white' });
    console.log(`🏠 Room created: ${roomId} by ${socket.username}`);
  });

  // Join private room
  socket.on("join-room", async (data) => {
    const { roomId, wallet, username } = data;
    socket.walletAddress = wallet;
    socket.username = username || "Player";

    const game = games[roomId];

    if (!game) {
      socket.emit("room-error", { message: "Room not found" });
      return;
    }

    if (game.player2) {
      socket.emit("room-error", { message: "Room is full" });
      return;
    }

    game.player2 = { socket, wallet: socket.walletAddress, username: socket.username, side: 'black' };
    game.status = 'playing';

    socket.join(roomId);
    socket.roomId = roomId;

    // Save to database
    const gameRecord = new Game({
      roomId,
      player1: game.player1.wallet,
      player2: socket.walletAddress,
      status: 'playing',
      gameType: 'friend'
    });
    await gameRecord.save();

    // Notify both players
    game.player1.socket.emit("opponent-joined", {
      opponent: { username: socket.username, wallet: socket.walletAddress }
    });

    socket.emit("room-joined", {
      roomId,
      side: 'black',
      opponent: { username: game.player1.username, wallet: game.player1.wallet }
    });

    console.log(`🤝 ${socket.username} joined room ${roomId}`);
  });

  // Game move
  socket.on("move", async (data) => {
    const { roomId, from, to } = data;
    const game = games[roomId];

    if (game) {
      game.moves.push({ from, to, timestamp: new Date() });
      socket.to(roomId).emit("move", { from, to });

      // Update database
      await Game.updateOne({ roomId }, { $push: { moves: { from, to, timestamp: new Date() } } });
    }
  });

  // Game over
  socket.on("game-over", async (data) => {
    const { roomId, winner, loser } = data;
    const game = games[roomId];

    if (game) {
      game.status = 'finished';

      // Update database
      await Game.updateOne({ roomId }, {
        status: 'finished',
        winner: winner,
        finishedAt: new Date()
      });

      // Update user stats
      if (winner && loser) {
        await User.updateOne({ walletAddress: winner }, {
          $inc: { wins: 1, gamesPlayed: 1, rating: 25 }
        });
        await User.updateOne({ walletAddress: loser }, {
          $inc: { losses: 1, gamesPlayed: 1, rating: -15 }
        });
      }

      // Notify players
      io.to(roomId).emit("game-ended", { winner });

      // Cleanup
      delete games[roomId];
    }
  });

  // Chat message
  socket.on("chat", (data) => {
    const { roomId, message } = data;
    socket.to(roomId).emit("chat", {
      username: socket.username,
      message,
      timestamp: new Date()
    });
  });

  // Resign
  socket.on("resign", async (data) => {
    const { roomId } = data;
    const game = games[roomId];

    if (game) {
      const winner = game.player1.socket.id === socket.id
        ? game.player2?.wallet
        : game.player1.wallet;

      io.to(roomId).emit("player-resigned", {
        resignedPlayer: socket.walletAddress,
        winner
      });

      // Update stats
      if (winner) {
        await User.updateOne({ walletAddress: winner }, {
          $inc: { wins: 1, gamesPlayed: 1, rating: 25 }
        });
        await User.updateOne({ walletAddress: socket.walletAddress }, {
          $inc: { losses: 1, gamesPlayed: 1, rating: -20 }
        });
      }

      await Game.updateOne({ roomId }, {
        status: 'finished',
        winner,
        finishedAt: new Date()
      });

      delete games[roomId];
    }
  });

  // Disconnect
  socket.on("disconnect", () => {
    console.log("👋 Player disconnected:", socket.id);
    onlineUsers--;
    io.emit("online-count", onlineUsers);

    // Remove from matchmaking queue
    const queueIndex = matchmakingQueue.findIndex(s => s.id === socket.id);
    if (queueIndex !== -1) {
      matchmakingQueue.splice(queueIndex, 1);
    }

    // Handle ongoing game
    if (socket.roomId && games[socket.roomId]) {
      const game = games[socket.roomId];
      socket.to(socket.roomId).emit("opponent-disconnected");
      delete games[socket.roomId];
    }
  });
});

// Helper function
function generateRoomId() {
  return Math.random().toString(36).substring(2, 10).toUpperCase();
}

// Start server
const PORT = process.env.PORT || 8050;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🎮 Vara Chess Backend Ready!`);
});
