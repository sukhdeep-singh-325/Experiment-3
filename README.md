# Experiment-3: Concurrent Ticket Booking System

> **Seat Locking with Redis | Atomic Operations | Concurrency Control**

## Objective

To create a concurrent ticket booking system with seat locking using Redis, preventing race conditions and double-booking when multiple users attempt to book the same seat simultaneously.

---

## Demo

Run the code live in your browser — **no installation required**:

[![Live Demo on Replit](https://img.shields.io/badge/Demo-Live%20on%20Replit-orange?logo=replit)](https://replit.com/@kalerona58/Experiment-3-Redis-Ticket-Booking)(https://replit.com/languages/python3)
> **How to run the demo:**
> 1. Go to [https://replit.com/languages/python3](https://replit.com/languages/python3)
> 2. Install the Redis client: in the Shell tab run `pip install redis`
> 3. Start a Redis instance via [Upstash](https://upstash.com/) (free tier) and update `host`, `port`, `password`
> 4. Paste `ticket_booking.py` and click **Run**

---

## Repository Structure

```
Experiment-3/
├── ticket_booking.js    # Node.js implementation (ioredis)
├── ticket_booking.py    # Python implementation (redis-py)
└── README.md
```

---

## How It Works

### The Problem: Race Conditions
Without locking, two users can read a seat as "available" at the same time and both successfully book it — resulting in a double-booking.

### The Solution: Redis Seat Locking

```
User A ──► SET lock:seat:5 userA NX PX 10000  ──► OK   (lock acquired)
User B ──► SET lock:seat:5 userB NX PX 10000  ──► nil  (lock already held!)
```

**`SET key value NX PX ttl`** is atomic — only one user wins the race.

---

## Redis Key Design

| Key Pattern | Type | Description |
|-------------|------|-------------|
| `lock:{event}:seat:{n}` | String | Seat lock (TTL = 10s, value = userId) |
| `status:{event}:seat:{n}` | String | Seat status: `available` / `booked` |
| `available:{event}` | String | Integer count of remaining seats |
| `booking:{bookingId}` | Hash | Full booking record |

---

## Core Operations

| Step | Operation | Redis Command | Description |
|------|-----------|---------------|-------------|
| 1 | Initialize | `SET` + Pipeline | Mark all seats available |
| 2 | Lock Seat | `SET NX PX` | Atomic seat hold (10s TTL) |
| 3 | Confirm Booking | Lua Script | Atomic: verify lock + mark booked + decrement count |
| 4 | Release Lock | `DEL` | User cancelled selection |
| 5 | Cancel Booking | `SET` + `INCR` | Free seat and restore count |
| 6 | Overview | `GET` + Pipeline | View all seat statuses |

---

## Lua Script (Atomic Confirm)

```lua
-- Verifies lock ownership + confirms booking in one atomic transaction
local owner = redis.call('GET', KEYS[1])   -- check lock
if owner ~= ARGV[1] then
  return redis.error_reply('LOCK_LOST')
end
redis.call('DEL',  KEYS[1])               -- remove lock
redis.call('SET',  KEYS[2], 'booked')     -- mark seat booked
redis.call('DECR', KEYS[3])               -- decrement available count
return 'OK'
```

---

## Concurrency Simulation

- **15 users** all try to book seats simultaneously
- Only **10 seats** available
- Race conditions are fully prevented — max 10 bookings succeed
- Uses `Promise.all` (Node.js) / `ThreadPoolExecutor` (Python)

**Sample output:**
```
=== Simulating Concurrent Bookings ===
  [LOCKED]  Seat 1 locked by user-1
  [LOCKED]  Seat 2 locked by user-2
  [BOOKED]  Seat 1 confirmed for user-1 (BKG-...)
  [FAILED]  Seat 1 failed for user-11: LOCK_LOST
  ...
=== Booking Results ===
  Successful: 10
  Failed    : 5
```

---

## How to Run Locally

### Node.js
```bash
npm install ioredis
node ticket_booking.js
```

### Python
```bash
pip install redis
python ticket_booking.py
```

> Requires a running Redis server on `localhost:6379`.
> Start with: `redis-server`

---

## Technologies Used

- **Redis** — In-memory data store for locking and state management
- **Node.js + ioredis** — JavaScript implementation
- **Python + redis-py** — Python implementation
- **Lua Scripting** — Atomic multi-step operations in Redis
- **Redis TTL** — Auto-release of expired locks

---

## Author

**sukhdeep-singh-325**
