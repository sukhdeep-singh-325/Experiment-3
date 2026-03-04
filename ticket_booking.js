/**
 * Experiment-3: Concurrent Ticket Booking System with Seat Locking using Redis
 *
 * Stack : Node.js + ioredis
 * Install: npm install ioredis
 * Run   : node ticket_booking.js
 *
 * Concepts demonstrated:
 *  - Atomic seat locking with SET NX PX (set-if-not-exists + TTL)
 *  - Lua scripts for atomic check-and-confirm
 *  - Concurrent booking simulation with Promise.all
 *  - Auto-release of expired locks
 *  - Booking confirmation stored as Redis Hash
 */

const Redis = require('ioredis');
const redis = new Redis(); // connects to localhost:6379 by default

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const LOCK_TTL_MS  = 10 * 1000;  // seat held for 10 seconds
const EVENT_ID     = 'EVT-CONCERT-2026';
const TOTAL_SEATS  = 10;

// ─── KEY HELPERS ─────────────────────────────────────────────────────────────
const seatLockKey    = (seat) => `lock:${EVENT_ID}:seat:${seat}`;
const seatStatusKey  = (seat) => `status:${EVENT_ID}:seat:${seat}`;
const bookingKey     = (bookingId) => `booking:${bookingId}`;
const availableKey   = () => `available:${EVENT_ID}`;

// ─── STEP 1: INITIALIZE SEATS ────────────────────────────────────────────────
async function initializeEvent() {
  console.log(`\n=== Initializing Event: ${EVENT_ID} ===`);
  const pipeline = redis.pipeline();

  for (let seat = 1; seat <= TOTAL_SEATS; seat++) {
    pipeline.set(seatStatusKey(seat), 'available');
  }
  // Store total available count
  pipeline.set(availableKey(), TOTAL_SEATS);
  await pipeline.exec();

  console.log(`${TOTAL_SEATS} seats initialized as available.`);
}

// ─── STEP 2: LOCK A SEAT (atomic SET NX PX) ──────────────────────────────────
/**
 * Returns true if lock acquired, false if seat already locked/booked.
 * Uses SET key value NX PX ttl  =>  atomic, no race condition.
 */
async function lockSeat(seat, userId) {
  const key   = seatLockKey(seat);
  const result = await redis.set(key, userId, 'NX', 'PX', LOCK_TTL_MS);
  return result === 'OK'; // OK = lock acquired, null = already locked
}

// ─── STEP 3: CONFIRM BOOKING (Lua atomic script) ─────────────────────────────
/**
 * Lua script ensures:
 *  1. The lock still belongs to this user (not expired and stolen)
 *  2. Seat status is still 'available'
 *  3. All three updates happen atomically:
 *     - Remove lock
 *     - Mark seat as 'booked'
 *     - Decrement available count
 */
const confirmBookingScript = `
  local lockKey    = KEYS[1]
  local statusKey  = KEYS[2]
  local availKey   = KEYS[3]
  local userId     = ARGV[1]

  -- Verify lock still belongs to this user
  local owner = redis.call('GET', lockKey)
  if owner ~= userId then
    return {err = 'LOCK_LOST: lock expired or taken by another user'}
  end

  -- Verify seat is still available
  local status = redis.call('GET', statusKey)
  if status ~= 'available' then
    return {err = 'SEAT_TAKEN: seat already booked'}
  end

  -- Atomically confirm booking
  redis.call('DEL', lockKey)
  redis.call('SET', statusKey, 'booked')
  redis.call('DECR', availKey)
  return 'OK'
`;

async function confirmBooking(seat, userId, bookingId) {
  try {
    const result = await redis.eval(
      confirmBookingScript,
      3,
      seatLockKey(seat),
      seatStatusKey(seat),
      availableKey(),
      userId
    );

    if (result === 'OK') {
      // Store booking details as a Redis Hash
      await redis.hset(bookingKey(bookingId), {
        bookingId,
        userId,
        seat,
        event:     EVENT_ID,
        status:    'confirmed',
        bookedAt:  new Date().toISOString()
      });
      // Set 24h expiry on booking record
      await redis.expire(bookingKey(bookingId), 86400);
      return { success: true, bookingId };
    }
  } catch (err) {
    return { success: false, reason: err.message };
  }
}

// ─── STEP 4: RELEASE LOCK (user cancelled selection) ─────────────────────────
async function releaseLock(seat, userId) {
  const lockKey = seatLockKey(seat);
  const owner   = await redis.get(lockKey);
  if (owner === userId) {
    await redis.del(lockKey);
    console.log(`  [RELEASED] Seat ${seat} lock released by ${userId}`);
    return true;
  }
  return false; // lock expired or not owned
}

// ─── STEP 5: CHECK SEAT STATUS ────────────────────────────────────────────────
async function getSeatStatus(seat) {
  const status  = await redis.get(seatStatusKey(seat));
  const lockedBy = await redis.get(seatLockKey(seat));
  return {
    seat,
    status: status || 'unknown',
    lockedBy: lockedBy || null
  };
}

// ─── STEP 6: GET ALL SEATS OVERVIEW ──────────────────────────────────────────
async function getEventOverview() {
  const available = await redis.get(availableKey());
  const seats = [];
  for (let s = 1; s <= TOTAL_SEATS; s++) {
    seats.push(await getSeatStatus(s));
  }
  return { event: EVENT_ID, availableCount: parseInt(available), seats };
}

// ─── STEP 7: CONCURRENT BOOKING SIMULATION ───────────────────────────────────
async function simulateConcurrentBookings() {
  console.log('\n=== Simulating Concurrent Bookings ===');

  // 15 users all try to book at the same time (only 10 seats available)
  const users = Array.from({ length: 15 }, (_, i) => ({
    userId:    `user-${i + 1}`,
    wantsSeat: (i % TOTAL_SEATS) + 1  // users spread across seats
  }));

  const bookAttempt = async ({ userId, wantsSeat }) => {
    const bookingId = `BKG-${Date.now()}-${userId}`;

    // 1. Try to lock the seat
    const locked = await lockSeat(wantsSeat, userId);
    if (!locked) {
      return { userId, seat: wantsSeat, result: 'FAILED', reason: 'Seat already locked' };
    }

    console.log(`  [LOCKED]  Seat ${wantsSeat} locked by ${userId}`);

    // 2. Simulate payment processing delay (100-300ms)
    await new Promise(r => setTimeout(r, Math.random() * 200 + 100));

    // 3. Confirm booking atomically
    const confirmation = await confirmBooking(wantsSeat, userId, bookingId);
    if (confirmation && confirmation.success) {
      console.log(`  [BOOKED]  Seat ${wantsSeat} confirmed for ${userId} (${bookingId})`);
      return { userId, seat: wantsSeat, result: 'SUCCESS', bookingId };
    } else {
      console.log(`  [FAILED]  Seat ${wantsSeat} booking failed for ${userId}: ${confirmation && confirmation.reason}`);
      return { userId, seat: wantsSeat, result: 'FAILED', reason: confirmation && confirmation.reason };
    }
  };

  // Fire all booking attempts concurrently
  const results = await Promise.all(users.map(bookAttempt));

  console.log('\n=== Booking Results ===');
  const successful = results.filter(r => r.result === 'SUCCESS');
  const failed     = results.filter(r => r.result === 'FAILED');
  console.log(`  Successful: ${successful.length}`);
  console.log(`  Failed    : ${failed.length}`);

  return results;
}

// ─── STEP 8: CANCEL A BOOKING ────────────────────────────────────────────────
async function cancelBooking(bookingId) {
  const booking = await redis.hgetall(bookingKey(bookingId));
  if (!booking || !booking.seat) {
    return { success: false, reason: 'Booking not found' };
  }

  // Free the seat
  await redis.set(seatStatusKey(booking.seat), 'available');
  await redis.incr(availableKey());
  await redis.hset(bookingKey(bookingId), 'status', 'cancelled');

  console.log(`  [CANCELLED] Booking ${bookingId} cancelled. Seat ${booking.seat} is now available.`);
  return { success: true };
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
(async () => {
  try {
    // Flush previous data for clean run
    await redis.flushall();

    await initializeEvent();
    await simulateConcurrentBookings();

    const overview = await getEventOverview();
    console.log('\n=== Final Seat Overview ===');
    console.log(`  Available: ${overview.availableCount} / ${TOTAL_SEATS}`);
    overview.seats.forEach(s => {
      const lock = s.lockedBy ? ` [locked by: ${s.lockedBy}]` : '';
      console.log(`  Seat ${s.seat}: ${s.status}${lock}`);
    });
  } finally {
    redis.disconnect();
  }
})();
