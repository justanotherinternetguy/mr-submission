package mech

// ============================== RULE SET: THE ONE BLOCK TO EDIT ==============================
// What the bot plays in a free-for-all when no environment variable is set (the scorer sets none).
// Everything here is inert until the free-for-all latch fires (b.px.ffa, set only by plusLatch in
// plus.go); the latch never fires against the house squad, so none of these values can change a
// practice match. The only values here that are read before the latch are the latch signals
// themselves: Evid, EvidProj, EvDeath, plusEvidDeathBy and plusEvidProjScore.
//
// To change the rule set: edit this block, rebuild the image, rerun the identity check.

// Latch signals and plus.go rules (switch names: the HAMSTER_FFA list at the top of plus.go).
var plusDefault = plusCfg{
	Evid:     true, // latch: mechs seen hitting other mechs. Must stay on: without it no rule below is ever active
	EvidProj: true, // latch: bullets in flight between other mechs
	EvDeath:  true, // latch: a death that is not our kill before plusEvidDeathBy seconds
	Hold:     true, // start no fight before 40 s
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
	plusEvidDeathBy   = 30.0 // evdeath: a death that is not our kill must show before this time (seconds)
	plusEvidProjScore = 6    // evidproj: this many bullets toward one victim within plusEvidWindow latch

	crBandDDefault    = 65.0 // band: keep this far from fresh mechs we do not attack (metres)
	crBandAwayDefault = 70.0 // band: when idle, step away from a fresh mech nearer than this (metres)

	plusPickHP    = 0.6 // pick: a mech at or above this share of its max HP is not opened on unless busy
	plusPickOwn   = 0.5 // pick: open nothing new while our own HP share is below this
	plusPickAlive = 4   // pick, duck: only while more than this many are alive
	plusDuckFor   = 3.0 // duck: seconds out of sight after a new attacker
)

// =========================== END OF THE RULE SET ===========================
