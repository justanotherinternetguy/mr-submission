package mech

import (
	"math"
	"math/rand"
)

// Per-match random streams. Each match is put in one of len(streamSalt) groups by its first
// next-circle center; a non-zero entry gives that group's matches their own random stream.
// All zero = the base stream everywhere.
var streamSalt = [32]int64{0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1000013, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0}

func streamGroup(nc [2]float64) int {
	x := uint64(int64(math.Round(nc[0] * 2)))
	y := uint64(int64(math.Round(nc[1] * 2)))
	h := x*0x9E3779B97F4A7C15 ^ (y + 0x632BE59BD9B4E019)
	h ^= h >> 31
	h *= 0xBF58476D1CE4E5B9
	h ^= h >> 29
	h *= 0x94D049BB133111EB
	h ^= h >> 32
	return int(h % uint64(len(streamSalt)))
}

func (b *Brain) streamPick(o *Obs) {
	if b.streamDone {
		return
	}
	b.streamDone = true
	if o.T > 45 {
		return
	}
	b.streamG = streamGroup(o.Zone.NextCenter)
	if s := streamSalt[b.streamG]; s != 0 {
		b.rng = rand.New(rand.NewSource(b.seed0 ^ s))
	}
}
