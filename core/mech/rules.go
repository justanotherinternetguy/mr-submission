package mech

// ============================== RULE SET: THE ONE BLOCK TO EDIT ==============================
// What the bot plays in a free-for-all when no environment variable is set (the scorer sets none).
// Everything here except streamSaltAll, H20 and P20 is inert until the free-for-all latch fires
// (b.px.ffa, set only by plusLatch in plus.go). The only other values read before the latch are the
// latch signals themselves: Evid, EvidProj, EvDeath, EvDeath2 and their numbers below.
//
// This file is written by the dev repo's scripts/ship/setrules.py; it can also be edited by hand.

// Latch signals and plus.go rules (switch names: the HAMSTER_FFA list at the top of plus.go).
var plusDefault = plusCfg{
	Evid:     true,  // latch: mechs seen hitting other mechs. Must stay on: without it no rule below is ever active
	EvidProj: true,  // latch: bullets in flight between other mechs
	EvDeath:  true,  // latch: a death that is not our kill before plusEvidDeathBy seconds
	EvDeath2: true,  // latch: two deaths that are not our kills before plusEvidDeath2By seconds
	Hold:     true,  // after the latch: start no fight before 40 s
	H20:      false, // BEFORE any latch, before plusEarlyUntil s: the hold rule only. Acts in practice too
	P20:      false, // BEFORE any latch, before plusEarlyUntil s: every rule here. Acts in practice too
	Pick:     false,
	Duck:     false,
}

// Field rules of exploit.go (switch names: the list at the top of exploit.go).
var crDefault = crCfg{
	TP:     true,
	Band:   true,
	Ring:   true,
	AimOff: true,
	End4:   true,
	Edge:   false,
}

const (
	plusEvidDeathBy   = 40.0  // evdeath: a death that is not our kill must show before this time (seconds; 1e9 = no cap)
	plusEvidDeath2By  = 100.0 // evdeath2: two deaths that are not our kills must show before this time (seconds)
	plusEvidProjScore = 6     // evidproj: this many bullets toward one victim within plusEvidWindow latch
	plusEarlyUntil    = 20.0  // h20, p20: they act before this time (seconds) and before any latch

	crBandDDefault    = 65.0 // band: keep this far from fresh mechs we do not attack (metres)
	crBandAwayDefault = 70.0 // band: when idle, step away from a fresh mech nearer than this (metres)

	plusPickHP    = 0.6 // pick: a mech at or above this share of its max HP is not opened on unless busy
	plusPickOwn   = 0.5 // pick: open nothing new while our own HP share is below this
	plusPickAlive = 4   // pick, duck: only while more than this many are alive
	plusDuckFor   = 3.0 // duck: seconds out of sight after a new attacker
)

// Whole-bot random stream. 0 = the base stream. Any other value re-rolls every random choice in every
// match (it is XORed into the match seed in NewBrain, before the first random number is drawn): the
// same play in distribution, a fresh draw on any fixed set of matches. Acts in practice too.
const streamSaltAll int64 = 0

// =========================== END OF THE RULE SET ===========================
