"""
Experiment-3: Concurrent Ticket Booking System with Seat Locking using Redis
Python Implementation

Install: pip install redis
Run    : python ticket_booking.py

Concepts demonstrated:
  - Atomic seat locking with SET NX PX
  - Lua scripts for atomic check-and-confirm
  - Concurrent booking simulation with ThreadPoolExecutor
  - Auto-expiring locks (TTL)
  - Booking stored as Redis Hash
"""

import redis
import time
import uuid
import random
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime

# ── CONFIG ────────────────────────────────────────────────────────────────────
LOCK_TTL_MS  = 10_000        # 10 seconds seat hold
EVENT_ID     = 'EVT-CONCERT-2026'
TOTAL_SEATS  = 10

# Redis connection
r = redis.Redis(host='localhost', port=6379, db=0, decode_responses=True)

# ── KEY HELPERS ───────────────────────────────────────────────────────────────
def seat_lock_key(seat):      return f"lock:{EVENT_ID}:seat:{seat}"
def seat_status_key(seat):    return f"status:{EVENT_ID}:seat:{seat}"
def booking_key(booking_id):  return f"booking:{booking_id}"
def available_key():          return f"available:{EVENT_ID}"

# ── STEP 1: INITIALIZE SEATS ─────────────────────────────────────────────────
def initialize_event():
    print(f"\n=== Initializing Event: {EVENT_ID} ===")
    pipe = r.pipeline()
    for seat in range(1, TOTAL_SEATS + 1):
        pipe.set(seat_status_key(seat), 'available')
    pipe.set(available_key(), TOTAL_SEATS)
    pipe.execute()
    print(f"{TOTAL_SEATS} seats initialized as available.")

# ── STEP 2: LOCK A SEAT (atomic SET NX PX) ───────────────────────────────────
def lock_seat(seat, user_id):
    """
    SET key value NX PX ttl
    Returns True if lock acquired, False if already locked.
    """
    result = r.set(seat_lock_key(seat), user_id, nx=True, px=LOCK_TTL_MS)
    return result is True

# ── STEP 3: CONFIRM BOOKING (Lua atomic script) ───────────────────────────────
CONFIRM_SCRIPT = """
  local lockKey   = KEYS[1]
  local statusKey = KEYS[2]
  local availKey  = KEYS[3]
  local userId    = ARGV[1]

  local owner = redis.call('GET', lockKey)
  if owner ~= userId then
    return redis.error_reply('LOCK_LOST')
  end

  local status = redis.call('GET', statusKey)
  if status ~= 'available' then
    return redis.error_reply('SEAT_TAKEN')
  end

  redis.call('DEL', lockKey)
  redis.call('SET', statusKey, 'booked')
  redis.call('DECR', availKey)
  return 'OK'
"""

_confirm_script = r.register_script(CONFIRM_SCRIPT)

def confirm_booking(seat, user_id, booking_id):
    try:
        result = _confirm_script(
            keys=[seat_lock_key(seat), seat_status_key(seat), available_key()],
            args=[user_id]
        )
        if result == 'OK':
            r.hset(booking_key(booking_id), mapping={
                'booking_id': booking_id,
                'user_id':    user_id,
                'seat':       seat,
                'event':      EVENT_ID,
                'status':     'confirmed',
                'booked_at':  datetime.utcnow().isoformat()
            })
            r.expire(booking_key(booking_id), 86400)  # 24h TTL
            return True, booking_id
        return False, 'UNKNOWN_ERROR'
    except redis.ResponseError as e:
        return False, str(e)

# ── STEP 4: RELEASE LOCK ─────────────────────────────────────────────────────
def release_lock(seat, user_id):
    lock_key = seat_lock_key(seat)
    owner = r.get(lock_key)
    if owner == user_id:
        r.delete(lock_key)
        print(f"  [RELEASED] Seat {seat} lock released by {user_id}")
        return True
    return False

# ── STEP 5: GET SEAT STATUS ───────────────────────────────────────────────────
def get_seat_status(seat):
    status    = r.get(seat_status_key(seat))
    locked_by = r.get(seat_lock_key(seat))
    return {'seat': seat, 'status': status or 'unknown', 'locked_by': locked_by}

# ── STEP 6: EVENT OVERVIEW ────────────────────────────────────────────────────
def get_event_overview():
    available = r.get(available_key())
    seats = [get_seat_status(s) for s in range(1, TOTAL_SEATS + 1)]
    return {'event': EVENT_ID, 'available_count': int(available or 0), 'seats': seats}

# ── STEP 7: SINGLE BOOKING ATTEMPT ───────────────────────────────────────────
def book_attempt(user_id, wants_seat):
    booking_id = f"BKG-{uuid.uuid4().hex[:8].upper()}-{user_id}"

    # 1. Try to lock
    locked = lock_seat(wants_seat, user_id)
    if not locked:
        return {'user_id': user_id, 'seat': wants_seat,
                'result': 'FAILED', 'reason': 'Seat already locked'}

    print(f"  [LOCKED]  Seat {wants_seat} locked by {user_id}")

    # 2. Simulate payment delay
    time.sleep(random.uniform(0.1, 0.3))

    # 3. Confirm atomically
    success, info = confirm_booking(wants_seat, user_id, booking_id)
    if success:
        print(f"  [BOOKED]  Seat {wants_seat} confirmed for {user_id} ({booking_id})")
        return {'user_id': user_id, 'seat': wants_seat,
                'result': 'SUCCESS', 'booking_id': booking_id}
    else:
        print(f"  [FAILED]  Seat {wants_seat} failed for {user_id}: {info}")
        return {'user_id': user_id, 'seat': wants_seat,
                'result': 'FAILED', 'reason': info}

# ── STEP 8: CONCURRENT SIMULATION ────────────────────────────────────────────
def simulate_concurrent_bookings():
    print('\n=== Simulating Concurrent Bookings ===')

    # 15 users competing for 10 seats
    users = [
        {'user_id': f'user-{i+1}', 'wants_seat': (i % TOTAL_SEATS) + 1}
        for i in range(15)
    ]

    results = []
    with ThreadPoolExecutor(max_workers=15) as executor:
        futures = [
            executor.submit(book_attempt, u['user_id'], u['wants_seat'])
            for u in users
        ]
        for f in as_completed(futures):
            results.append(f.result())

    successful = [r for r in results if r['result'] == 'SUCCESS']
    failed     = [r for r in results if r['result'] == 'FAILED']
    print(f"\n=== Booking Results ===")
    print(f"  Successful: {len(successful)}")
    print(f"  Failed    : {len(failed)}")
    return results

# ── STEP 9: CANCEL BOOKING ────────────────────────────────────────────────────
def cancel_booking(booking_id):
    booking = r.hgetall(booking_key(booking_id))
    if not booking or 'seat' not in booking:
        return False, 'Booking not found'
    seat = booking['seat']
    r.set(seat_status_key(seat), 'available')
    r.incr(available_key())
    r.hset(booking_key(booking_id), 'status', 'cancelled')
    print(f"  [CANCELLED] Booking {booking_id} cancelled. Seat {seat} is now available.")
    return True, 'OK'

# ── MAIN ──────────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    r.flushall()  # clean slate

    initialize_event()
    simulate_concurrent_bookings()

    overview = get_event_overview()
    print(f"\n=== Final Seat Overview ===")
    print(f"  Available: {overview['available_count']} / {TOTAL_SEATS}")
    for s in overview['seats']:
        lock_info = f" [locked by: {s['locked_by']}]" if s['locked_by'] else ''
        print(f"  Seat {s['seat']}: {s['status']}{lock_info}")
