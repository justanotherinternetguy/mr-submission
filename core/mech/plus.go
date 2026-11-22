package mech

// ffa: changes to the FREE-FOR-ALL play only.
//
// Every rule here is gated twice: by b.px.ffa and by one switch. b.px.ffa is set ONLY by the evid latch (plusEvid:
// repeated hits of mechs on other mechs, none of them ours and none explainable by fire aimed at us), never by
// base's latch b.notPractice ("a mech died that I did not kill"): in simulated practice a house bot is killed by
// stray squad fire before 60 s in about 3 matches of 100, and base's latch fires on that. So without the evid
// switch no rule here is ever active, and against the house squad (which never fights itself) the bot is base
// in every case. The switches
// come from the environment variable HAMSTER_FFA, a comma-separated list (for example "duel,late"); "all" turns every
// switch on, "none" or an empty value turns every switch off (= base behaviour). When the variable is not set
// or is "default" the switches are plusDefault below.
//
//	duel   leave a fight that is being lost: more than plusDuelLoss of max HP gone in 3 s and the target not weaker
//	multi  two different mechs hit us within 4 s, or a mech we cannot see hit us while we have a target: take cover
//	low    retreat at plusLowHP instead of 0.38 while more than 4 are alive (stay above the 350 HP trigger of copies)
//	late   end-game: keep retreat and hiding until 2 are alive; with 3 or 4 alive do not open on a mech inside 60 m
//	       that has more HP and looks at us; do not walk to the centre when the 25 m circle is announced
//	quiet  after the latch and before plusQuietUntil s: engage only a mech that hit us, is inside 35 m or is nearly
//	       dead; take cover when a mech has a line on us (base's EarlyHide rule)
//	grow   from plusGrowFrom s: crates and drones all match, loot radius 130 m (base: 90 m, crates until 150 s)
//	drops  from plusGrowFrom s: take a supply drop when no mech was seen near it
//	shy    base's unused Shy rule at plusShyDist: a mech between 60 m and that distance that closes on us or
//	       aims at us, and is not a target, makes us step out of its sight
//	alert  base's unused Alert rule at plusAlertDist: such a mech is a target at once (we shoot first)
//	odds   base's unused OddsFlee rule at plusOddsFlee: leave a target against which base's own
//	       win estimate (HP, cubes, weapons, who is busy) is below that value
//	hold   after the latch and before plusHoldUntil s: start no fight; a mech is a target only when it hit us in the
//	       last 4 s, is inside plusHoldNear m, is below plusHoldHurt of its max HP, or aims at another mech (busy).
//	       No hiding added (unlike quiet).
//	nofirst after the latch, all match while more than 2 are alive, and only while we hold no laser: a mech that has
//	       not hit us in the last plusNoFirstHit s is not a target when it is beyond plusNoFirstD m or carries a laser
//	       (a "never fire first" rule).
//	endg   (after the latch) a hold-out end-game: base's "late"
//	       (no retreat, no hiding) only from a next circle of plusEndgLateR m or 3 alive (base: 70 m); when the
//	       final circle is announced and more than 2 are alive, until plusEndgUntil s, wait at a hidden spot
//	       plusEndgMin to plusEndgMin+25 m from the final centre instead of walking to it. "late" takes precedence.
//	evid   THE ONE SWITCH THAT ACTS BEFORE THE FIRST DEATH: it sets base's latch b.notPractice as soon as the bot
//	       has watched mechs shoot each other (see plusEvid). In practice the 15 house bots never fight each other,
//	       so it must never fire there; when it does not fire the bot is base.
import (
	"fmt"
	"math"
	"os"
	"strconv"
	"strings"
)

type plusCfg struct {
	Duel, Multi, Low, Late, Quiet, Grow, Drops bool
	Shy, Alert, Odds                           bool
	Evid                                       bool
	Hold, NoFirst, Endg                        bool
	EvidShadow                                 bool
	EvidLoss                                   bool // a second evid signal (see plusEvid), an OR // evid computed and logged, never latched (measuring only)
}

// The configuration that ships when HAMSTER_FFA is not set.
var plusDefault = plusCfg{Evid: true, Hold: true} // shipped: free-for-all detection + hold fire before 40 s

const (
	plusDuelLoss   = 0.25 // share of max HP lost in plusDuelWindow seconds that counts as "losing"
	plusDuelWindow = 3.0
	plusDuelWeaker = 0.8 // a target below this share of our HP is "weaker": keep fighting it
	plusFleeFor    = 4.0
	plusLowHP      = 0.5
	plusQuietUntil = 60.0
	plusQuietNear  = 35.0
	plusGrowFrom   = 100.0
	plusGrowRadius = 130.0
	plusDropClear  = 100.0 // no mech seen within this many metres of a drop ...
	plusDropMemory = 15.0  // ... in the last this many seconds
	plusDropMaxD   = 220.0
	plusShyDist    = 120.0
	plusHoldUntil  = 40.0  // hold: no fight started before this time ...
	plusHoldNear   = 35.0  // ... unless the mech is this close,
	plusHoldHurt   = 0.67  // ... below this share of its max HP, has hit us, or is busy with another mech
	plusNoFirstD   = 55.0  // nofirst: without a laser of our own, open on no mech beyond this (or with a laser)
	plusNoFirstHit = 6.0   // ... that has not hit us in this many seconds
	plusEndgLateR  = 25.0  // endg: base's "late" (no retreat, no hiding) from this next radius (base 70 m)
	plusEndgUntil  = 368.0 // endg: hold out away from the final centre until this time ...
	plusEndgMin    = 60.0  // ... at a spot this far from the final centre (to plusEndgMin + 25 m)
	plusAlertDist  = 110.0
	plusOddsFlee   = 0.35

	// evid (see plusEvid)
	plusEvidUntil   = 60.0 // no evidence is collected after this time
	plusEvidGunLo   = 38.0 // a one-observation HP loss in [GunLo, GunHi] is "gun-like" (one or two bullets)
	plusEvidGunHi   = 100.0
	plusEvidLaserW  = 3    // weight of a laser beam of one mech ending on another
	plusEvidArcW    = 2    // weight of a lightning arc of one mech whose first jump ends on another
	plusEvidWindow  = 6.0  // seconds over which unit events are added up
	plusEvidScore   = 6    // latch when one victim has gun-like + 3 x laser-like >= this within the window
	plusEvidAimTol  = 0.3  // a mech whose aim is within this of the bearing to us "aims at us"
	plusEvidLineR   = 25.0 // a victim this near to us, or to the aim line of a mech that aims at us, does not count
	plusEvidLossMin = 20.0 // evidloss: per-observation losses from this size count ...
	plusEvidLossSum = 250  // ... and one victim losing this much ...
	plusEvidLossWin = 2.0  // ... within this many seconds latches
	plusEvidQuiet   = 2.0  // seconds after any sign that we are being attacked during which nothing counts
)

type plusState struct {
	cfg       plusCfg
	any       bool
	behave    bool    // a switch that changes play after the latch is on (anything but evid / evidshadow)
	ffa       bool    // the rules are active (see the top of this file)
	latchAt   float64 // time at which b.notPractice was first seen true, -1 before
	hpT, hpV  []float64
	hitBy     map[int]float64
	unseenAt  float64
	fleeUntil float64
	homeXY    [2]float64
	homeAt    float64
	homeSet   bool
	// evid
	evPrevHP, evPrevT map[int]float64
	evMyHit           map[int]float64
	evMyDmg           map[int]float64 // damage we dealt to each id in this observation ("hit" events)
	evUnits           []evUnit
	evLoss            []evUnit // evidloss: (time, victim, HP lost to others)
	evAimers          []int    // indexes in o.Mechs of the mechs aiming at us (this observation)
	fireAt, attackAt  float64
	mortarAt          float64
	evidAt, deathAt   float64
	evidCause         string
	evLogged          int
	evK               int  // latch weight: plusEvidScore, or HAMSTER_FFA_EVIDK (lab only, for margin tests)
	evDbg             bool // HAMSTER_FFA_EVDBG set: one stderr line per candidate HP step (diagnostics only)
	// counters for the optional log line
	nDuel, nMulti, nUnseen, nShy, nQuiet, nHold, nDrop int
	nHoldOff, nNoFirst                                 int
	endHideOn                                          bool // hamsters: practice endgame switch fired (plusEndHide)
	ffaAt                                              float64
}

type evUnit struct {
	t      float64
	victim int
	w      int // 1 gun-like, 3 laser-like
}

func loadPlus() plusCfg {
	v, ok := os.LookupEnv("HAMSTER_FFA")
	if !ok || strings.TrimSpace(v) == "default" {
		return plusDefault
	}
	var c plusCfg
	for _, f := range strings.Split(v, ",") {
		switch strings.TrimSpace(f) {
		case "all":
			// "all" = the seven rules written here; shy, alert and odds are named separately
			c.Duel, c.Multi, c.Low, c.Late, c.Quiet, c.Grow, c.Drops = true, true, true, true, true, true, true
		case "duel":
			c.Duel = true
		case "multi":
			c.Multi = true
		case "low":
			c.Low = true
		case "late":
			c.Late = true
		case "quiet":
			c.Quiet = true
		case "grow":
			c.Grow = true
		case "drops":
			c.Drops = true
		case "shy":
			c.Shy = true
		case "alert":
			c.Alert = true
		case "odds":
			c.Odds = true
		case "evid":
			c.Evid = true
		case "hold":
			c.Hold = true
		case "nofirst":
			c.NoFirst = true
		case "endg":
			c.Endg = true
		case "evidloss":
			c.EvidLoss = true
		case "evidshadow":
			c.EvidShadow = true
		}
	}
	return c
}

func (b *Brain) plusInit() {
	c := loadPlus()
	b.px = plusState{cfg: c, hitBy: map[int]float64{}, unseenAt: -100, fleeUntil: -100, ffaAt: -1, latchAt: -1,
		evPrevHP: map[int]float64{}, evPrevT: map[int]float64{}, evMyHit: map[int]float64{}, evMyDmg: map[int]float64{}, fireAt: -100, attackAt: -100,
		mortarAt: -100, evidAt: -1, deathAt: -1}
	b.px.any = c != plusCfg{}
	b.px.evDbg = os.Getenv("HAMSTER_FFA_EVDBG") != ""
	b.px.evK = plusEvidScore
	if k, err := strconv.Atoi(os.Getenv("HAMSTER_FFA_EVIDK")); err == nil && k > 0 {
		b.px.evK = k
	}
	b.px.behave = c != plusCfg{Evid: c.Evid, EvidShadow: c.EvidShadow, EvidLoss: c.EvidLoss}
}

// on: a switch is on and the match is known to be a free-for-all.
func (b *Brain) plusOn(sw bool) bool { return sw && b.px.ffa }

// plusOnHit is bookkeeping only (called for every "damaged" event with a known attacker).
func (b *Brain) plusOnHit(by int, now float64) {
	if !b.px.any {
		return
	}
	if _, npc := b.npcs[by]; npc || by >= 100 {
		return
	}
	b.px.hitBy[by] = now
	if t := b.tracks[by]; t == nil || now-t.Seen > 0.5 {
		b.px.unseenAt = now
	}
}

// plusTick runs once per decision right after observe(): HP history and the parameter overrides.
func (b *Brain) plusTick(o *Obs) {
	if !b.px.any {
		return
	}
	now := o.T
	p := &b.px
	p.hpT, p.hpV = append(p.hpT, now), append(p.hpV, o.Self.HP)
	for len(p.hpT) > 1 && now-p.hpT[0] > plusDuelWindow {
		p.hpT, p.hpV = p.hpT[1:], p.hpV[1:]
	}
	if p.deathAt < 0 && b.baseSet && b.startAlive-o.Alive-b.kills > 0 {
		p.deathAt = now // when base's own evidence (a death that is not our kill) first shows
	}
	if b.notPractice && p.latchAt < 0 {
		p.latchAt = now
		// The behaviour rules are NOT opened by base's latch: in simulated practice a house bot is killed by
		// another house bot's stray fire before 60 s in about 3 matches of 100, which sets base's latch.
		// p.ffa is set only by the evid latch (plusEvid), which needs repeated mech-on-mech hits.
	}
	if !p.ffa || b.pracOn || b.openOn {
		return
	}
	if !p.behave {
		return // only measuring switches are on (evidshadow): leave b.P exactly as base set it
	}
	if p.ffaAt < 0 {
		p.ffaAt = now
	}
	q := b.base
	if p.cfg.Low && o.Alive > 4 {
		q.RetreatHP = plusLowHP
	}
	if p.cfg.Quiet && now < plusQuietUntil {
		q.EarlyHide = plusQuietUntil
	}
	if p.cfg.Grow && now >= plusGrowFrom {
		q.CrateUntil = 1e9
		q.LootRadius = plusGrowRadius
	}
	if p.cfg.Drops && now >= plusGrowFrom {
		q.UseDrops = true
	}
	if p.cfg.Shy {
		q.Shy = plusShyDist
	}
	if p.cfg.Alert {
		q.Alert = plusAlertDist
	}
	if p.cfg.Odds {
		q.OddsFlee = plusOddsFlee
	}
	b.P = q
}

// plusLate replaces base's "late" (next radius <= 70 m or 3 alive: never retreat, never hide).
func (b *Brain) plusLate(late bool, o *Obs) bool {
	if b.plusOn(b.px.cfg.Late) {
		return o.Alive <= 2
	}
	if b.plusOn(b.px.cfg.Endg) {
		return o.Zone.NextRadius <= plusEndgLateR || o.Alive <= 3
	}
	return late
}

// plusEngage edits base's decision "this mech is a target" for one visible mech (Ghost profile only).
func (b *Brain) plusEngage(t *Track, o *Obs, shy **Track) {
	if !b.px.ffa || !t.Engage {
		return
	}
	me := &o.Self
	now := o.T
	hitMe := now-t.HitMe < 4
	weak := t.HP < 350 && t.Dist < 120
	if b.px.cfg.Hold && now < plusHoldUntil && !hitMe && t.Dist >= plusHoldNear && t.HP >= plusHoldHurt*t.MaxHP && !b.plusBusy(t, now) {
		t.Engage = false
		b.px.nHoldOff++
		return
	}
	if b.px.cfg.NoFirst && o.Alive > 2 && now-t.HitMe >= plusNoFirstHit && (t.Dist > plusNoFirstD || holds(t.Weapons, "laser")) && !b.plusHaveLaser(o) {
		t.Engage = false
		b.px.nNoFirst++
		return
	}
	if b.px.cfg.Quiet && now < plusQuietUntil && !hitMe && !weak && t.Dist >= plusQuietNear {
		t.Engage = false
		b.px.nQuiet++
		return
	}
	if b.px.cfg.Late && o.Alive >= 3 && o.Alive <= 4 && !hitMe && !weak && t.Dist >= 30 && t.HP > me.HP*1.1 {
		toMe := math.Atan2(me.Pos[1]-t.Pos[1], me.Pos[0]-t.Pos[0])
		if math.Abs(angDiff(t.Aim[0], toMe)) < 0.6 {
			// a larger mech that looks at us and has not fired: do not open, step out of its sight
			t.Engage = false
			if t.LOS && (*shy == nil || t.Dist < (*shy).Dist) {
				*shy = t
			}
			b.px.nShy++
		}
	}
}

func (b *Brain) plusHaveLaser(o *Obs) bool {
	for _, w := range o.Self.Weapons {
		if w != nil && w.Kind == "laser" {
			return true
		}
	}
	return false
}

// plusBusy: is t fighting another mech (not us)? It aims within 0.2 rad of another mech seen in the last 2.5 s and
// within 160 m of it: base's own "busy" test in odds().
func (b *Brain) plusBusy(t *Track, now float64) bool {
	for _, u := range b.tracks {
		if u.ID == t.ID || now-u.Seen > 2.5 {
			continue
		}
		br := math.Atan2(u.Pos[1]-t.Pos[1], u.Pos[0]-t.Pos[0])
		if math.Abs(angDiff(t.Aim[0], br)) < 0.2 && hyp(u.Pos[0]-t.Pos[0], u.Pos[1]-t.Pos[1]) < 160 {
			return true
		}
	}
	return false
}

// plusFlee: true while the bot should count as "swamped" (base then goes to cover until HP > 80 %).
func (b *Brain) plusFlee(o *Obs, target *Track, finishing bool) bool {
	if !b.px.ffa || finishing || !(b.px.cfg.Duel || b.px.cfg.Multi) {
		return false
	}
	p := &b.px
	me := &o.Self
	now := o.T
	if p.cfg.Multi {
		n := 0
		for id, at := range p.hitBy {
			if now-at < 4 {
				n++
			} else if now-at > 30 {
				delete(p.hitBy, id)
			}
		}
		if n >= 2 && now >= p.fleeUntil {
			p.fleeUntil = now + plusFleeFor
			p.nMulti++
		}
		if target != nil && now-p.unseenAt < 0.2 && now >= p.fleeUntil {
			p.fleeUntil = now + plusFleeFor
			p.nUnseen++
		}
	}
	if p.cfg.Duel && len(p.hpV) > 0 && now >= p.fleeUntil {
		loss := (p.hpV[0] - me.HP) / math.Max(1, me.MaxHP)
		weaker := target != nil && target.HP < me.HP*plusDuelWeaker
		if loss >= plusDuelLoss && !weaker && now-b.lastHurt < 1.5 {
			p.fleeUntil = now + plusFleeFor
			p.nDuel++
		}
	}
	return now < p.fleeUntil
}

// plusCover: base's cover search. With duel or multi on (free-for-all only) it also hides from the bearing of
// the last hit when the shooter is not seen, instead of walking to the zone goal as base does in that case.
func (b *Brain) plusCover(o *Obs, seen []*Track, mx, my *float64) bool {
	if !b.px.ffa || !(b.px.cfg.Duel || b.px.cfg.Multi) {
		return b.coverMove(o, seen, mx, my)
	}
	if b.px.cfg.Multi && o.T-b.px.unseenAt < 2.5 {
		return b.hideFromBearing(o, seen, mx, my)
	}
	if b.coverMove(o, seen, mx, my) {
		return true
	}
	if o.T-b.lastHurt < 2.5 {
		return b.hideFromBearing(o, seen, mx, my)
	}
	return false
}

// plusHold: do not walk to the centre when the last small circle is announced; hold a low-exposure spot inside
// the current circle (the zone rules above still move the bot before the edge arrives).
func (b *Brain) plusHold(o *Obs) bool {
	if b.plusOn(b.px.cfg.Endg) && !b.px.cfg.Late {
		return o.Zone.NextRadius <= 30 && o.Alive > 2 && o.T < plusEndgUntil
	}
	return b.plusOn(b.px.cfg.Late) && o.Zone.NextRadius <= 30 && o.Alive > 2
}

func (b *Brain) plusHome(o *Obs) (float64, float64, bool) {
	if b.px.cfg.Endg && !b.px.cfg.Late {
		return b.plusEndgHome(o)
	}
	p := &b.px
	z := &o.Zone
	cur := b.curZone(z)
	R := math.Max(cur.R-12, z.NextRadius)
	out := !p.homeSet || hyp(p.homeXY[0]-cur.X, p.homeXY[1]-cur.Y) > R
	if out || b.now-p.homeAt > 8 {
		p.homeAt = b.now
		best, bestC := [2]float64{}, math.Inf(1)
		for k := 0; k < 40; k++ {
			a := b.rng.Float64() * 2 * math.Pi
			r := math.Sqrt(b.rng.Float64()) * R * 0.9
			px, py := cur.X+math.Cos(a)*r, cur.Y+math.Sin(a)*r
			if !b.W.InBounds(px, py) || !b.W.Reachable(px, py) {
				continue
			}
			if c := b.homeCost(o, px, py); c < bestC {
				best, bestC = [2]float64{px, py}, c
			}
		}
		if !math.IsInf(bestC, 1) && (out || bestC < b.homeCost(o, p.homeXY[0], p.homeXY[1])-15) {
			p.homeXY, p.homeSet = best, true
			p.nHold++
		}
	}
	return p.homeXY[0], p.homeXY[1], p.homeSet
}

// plusEndgHome (endg): a low-exposure spot inside the current circle, plusEndgMin to plusEndgMin+25 m from the
// final centre; base's zone rules still move the bot in before the edge arrives.
func (b *Brain) plusEndgHome(o *Obs) (float64, float64, bool) {
	p := &b.px
	z := &o.Zone
	cur := b.curZone(z)
	valid := func(px, py float64) bool {
		return hyp(px-z.NextCenter[0], py-z.NextCenter[1]) >= plusEndgMin*0.8 && hyp(px-cur.X, py-cur.Y) <= cur.R-12
	}
	if !p.homeSet || !valid(p.homeXY[0], p.homeXY[1]) || b.now-p.homeAt > 12 {
		p.homeAt = b.now
		best, bestC := [2]float64{}, math.Inf(1)
		for k := 0; k < 48; k++ {
			a := b.rng.Float64() * 2 * math.Pi
			r := plusEndgMin + b.rng.Float64()*25
			px, py := z.NextCenter[0]+math.Cos(a)*r, z.NextCenter[1]+math.Sin(a)*r
			if !valid(px, py) || !b.W.InBounds(px, py) || !b.W.Reachable(px, py) {
				continue
			}
			if c := b.homeCost(o, px, py); c < bestC {
				best, bestC = [2]float64{px, py}, c
			}
		}
		if !math.IsInf(bestC, 1) && (!p.homeSet || !valid(p.homeXY[0], p.homeXY[1]) || bestC < b.homeCost(o, p.homeXY[0], p.homeXY[1])-15) {
			p.homeXY, p.homeSet = best, true
			p.nHold++
		}
	}
	return p.homeXY[0], p.homeXY[1], p.homeSet
}

// plusDropOK: the extra conditions for walking to a supply drop (base's own conditions still apply).
func (b *Brain) plusDropOK(o *Obs, d *Drop, hpFrac float64) bool {
	if !b.plusOn(b.px.cfg.Drops) {
		return true
	}
	me := &o.Self
	if d.Holder != nil && *d.Holder != me.ID {
		return false
	}
	dist := hyp(d.Pos[0]-me.Pos[0], d.Pos[1]-me.Pos[1])
	if dist > plusDropMaxD {
		return false
	}
	// leave so as to arrive when it lands, not earlier: the landing point is open ground
	if d.LandsIn > dist*1.4/math.Max(1, me.Stats.WalkSpeed)+5 {
		return false
	}
	for _, t := range b.tracks {
		if b.now-t.Seen < plusDropMemory && hyp(t.Pos[0]-d.Pos[0], t.Pos[1]-d.Pos[1]) < plusDropClear {
			return false
		}
	}
	b.px.nDrop++
	return true
}

// PlusLog is one line for stderr at the end of a match (only printed when HAMSTER_LOG is set).
func (b *Brain) PlusLog() string {
	p := &b.px
	return fmt.Sprintf("ffa cfg=%+v evidAt=%.1f cause=%q deathAt=%.1f latchAt=%.1f ffaAt=%.1f duel=%d multi=%d unseen=%d shy=%d quiet=%d hold=%d dropTicks=%d holdOff=%d nofirst=%d panics=%d",
		p.cfg, p.evidAt, p.evidCause, p.deathAt, p.latchAt, p.ffaAt, p.nDuel, p.nMulti, p.nUnseen, p.nShy, p.nQuiet, p.nHold, p.nDrop, p.nHoldOff, p.nNoFirst, b.Panics)
}

// plusAfter remembers when we last pulled any trigger (our own bullets and beams must not count as evidence).
func (b *Brain) plusAfter(o *Obs, act *Action) {
	if (b.px.cfg.Evid || b.px.cfg.EvidShadow) && (act.Fire[0] || act.Fire[1]) {
		b.px.fireAt = o.T
	}
}

// plusEvid: recognise a free-for-all before the first death, from mechs damaging each other.
//
// A unit event is a listed mech (not us) that loses HP between two consecutive observations in a way only a mech's
// weapon explains:
//   - gun-like:   a loss of plusEvidGunLo..plusEvidGunHi (one or two gun bullets; a drone bullet is 25, or 37.5 from
//     behind, and sums of drone bullets are excluded by value), weight 1;
//   - a beam: a laser (weight plusEvidLaserW) or the first jump of a lightning arc (plusEvidArcW) of a listed mech that
//     ends on another listed mech (plusBeamUnit), with the same exclusions.
//
// Nothing counts
//   - after plusEvidUntil seconds, or once the latch is set;
//   - our own damage: the amounts of this observation's "hit" events on that mech are taken off the loss first;
//   - for plusEvidQuiet seconds after a sign that we are the one being attacked: we took damage from a mech, or a
//     bullet or shell is flying at us;
//   - for a mech within plusEvidLineR of us while a listed mech aims at us (within plusEvidAimTol), or within
//     plusEvidLineR of the aim line of such a mech, in front of us or behind us (a hunter that shoots at us can hit
//     a house bot standing on that line, and lightning chains and splash reach mechs near us);
//   - for 3 s after a mortar shell was in sight or a mortar carrier aimed at us; for a mech that holds a mortar;
//   - for a mech outside the circle (zone damage);
//   - for a loss that is a sum of drone bullets (25 and 37.5, times 1, 0.92, 0.84 or 0.76 for armour upgrades);
//   - when the previous sample of that mech is older than one observation step.
//
// With switch evidloss there is a second way to latch (an OR, on a large loss in a short time): one
// victim losing plusEvidLossSum HP within plusEvidLossWin s in per-observation losses of plusEvidLossMin or more,
// after the same exclusions (our own damage taken off, attacked, aim line, mortar, zone, drone sums).
// It keeps watching after base's own latch; only its own latch opens the rules (b.px.ffa).
//
// The latch is set when one victim collects a weight of plusEvidScore within plusEvidWindow seconds: that is six gun
// hits, or two laser hits, or a laser hit and three gun hits, on the same mech, none of them ours.
func (b *Brain) plusEvid(o *Obs) {
	p := &b.px
	if !p.cfg.Evid && !p.cfg.EvidShadow {
		return
	}
	now := o.T
	// evid keeps watching after base's own latch (only its own latch opens the rules); it stops at its latch
	if p.evidAt >= 0 || now > plusEvidUntil {
		return
	}
	me := &o.Self
	x, y := me.Pos[0], me.Pos[1]
	for k := range p.evMyDmg {
		delete(p.evMyDmg, k)
	}
	for i := range o.Events {
		e := &o.Events[i]
		switch e.Type {
		case "hit":
			p.evMyHit[e.Target] = now
			p.evMyDmg[e.Target] += e.Amount
		case "damaged":
			if e.By != nil && *e.By < 100 {
				p.attackAt = now
			}
		}
	}
	for i := range o.Projectiles {
		q := &o.Projectiles[i]
		if q.Kind == "mortar" {
			p.mortarAt = now
		}
		if q.Kind == "npc" {
			continue
		}
		vh2 := q.Vel[0]*q.Vel[0] + q.Vel[1]*q.Vel[1]
		if vh2 < 1 {
			continue
		}
		tc := ((x-q.Pos[0])*q.Vel[0] + (y-q.Pos[1])*q.Vel[1]) / vh2
		if tc > 0 && tc < 2 && hyp(q.Pos[0]+q.Vel[0]*tc-x, q.Pos[1]+q.Vel[1]*tc-y) < 12 {
			p.attackAt = now
		}
	}
	// mechs that aim at us: their fire at us can hit a mech on that line (in front of us or behind us) or near us
	p.evAimers = p.evAimers[:0]
	for i := range o.Mechs {
		m := &o.Mechs[i]
		if m.Kind != "mech" {
			continue
		}
		d := hyp(m.Pos[0]-x, m.Pos[1]-y)
		if d < 300 && math.Abs(angDiff(m.Aim[0], math.Atan2(y-m.Pos[1], x-m.Pos[0]))) < plusEvidAimTol {
			p.evAimers = append(p.evAimers, i)
			if holds(m.Weapons, "mortar") {
				p.mortarAt = now // a mortar aimed our way: its splash can hit anything near us
			}
		}
	}
	quiet := now-p.attackAt < plusEvidQuiet || now-p.mortarAt < 3
	zc := b.curZone(&o.Zone)
	for i := range o.Mechs {
		m := &o.Mechs[i]
		if m.Kind != "mech" || m.MaxHP <= 0 {
			continue
		}
		prevHP, okH := p.evPrevHP[m.ID]
		prevT := p.evPrevT[m.ID]
		p.evPrevHP[m.ID], p.evPrevT[m.ID] = m.HP, now
		if !okH || now-prevT > 0.125 {
			continue
		}
		// our own damage this observation is taken off: what is left was done by someone else (every damage we deal,
		// splash and chains included, comes as a "hit" event in the same observation as the HP change)
		step := prevHP - m.HP - p.evMyDmg[m.ID]
		if step < plusEvidLossMin {
			continue
		}
		if p.evDbg {
			nn := 1e9
			for _, n := range b.npcs {
				nn = math.Min(nn, hyp(n.Pos[0]-m.Pos[0], n.Pos[1]-m.Pos[1]))
			}
			fmt.Fprintf(os.Stderr, "gpdbg t=%.1f victim=%d step=%.1f dist=%.0f attack=%.1f fire=%.1f mortar=%.1f myhit=%.1f holdsMortar=%v outZone=%v npc=%.0f drone=%v beam=%v aimline=%v\n",
				now, m.ID, step, hyp(m.Pos[0]-x, m.Pos[1]-y), now-p.attackAt, now-p.fireAt, now-p.mortarAt, now-p.evMyHit[m.ID], holds(m.Weapons, "mortar"),
				hyp(m.Pos[0]-zc.X, m.Pos[1]-zc.Y) > zc.R-3, nn, plusDroneSum(step), false, b.plusOnAimLine(o, m, x, y))
			for _, bm := range o.Beams {
				if len(bm.Path) >= 2 {
					e := bm.Path[len(bm.Path)-1]
					fmt.Fprintf(os.Stderr, "gpdbg   beam by=%d kind=%s endToVictim=%.1f endZ=%.1f victimZ=%.1f aimers=%d\n", bm.By, bm.Kind, hyp(e[0]-m.Pos[0], e[1]-m.Pos[1]), e[2], m.Pos[2], len(p.evAimers))
				}
			}
		}
		if quiet {
			continue
		}
		if b.plusOnAimLine(o, m, x, y) {
			continue
		}
		if holds(m.Weapons, "mortar") || hyp(m.Pos[0]-zc.X, m.Pos[1]-zc.Y) > zc.R-3 {
			continue
		}
		if p.cfg.EvidLoss && !plusDroneSum(step) {
			p.evLoss = append(p.evLoss, evUnit{now, m.ID, int(step)})
		}
		if step < plusEvidGunLo {
			continue
		}
		w := 0
		switch {
		case step <= plusEvidGunHi:
			if plusDroneSum(step) {
				continue
			}
			w = 1
		}
		if w == 0 {
			continue
		}
		p.evUnits = append(p.evUnits, evUnit{now, m.ID, w})
		if p.evLogged < 300 && os.Getenv("HAMSTER_LOG") != "" {
			p.evLogged++
			fmt.Fprintf(os.Stderr, "gpev t=%.1f w=%d victim=%d step=%.1f dist=%.0f\n", now, w, m.ID, step, hyp(m.Pos[0]-x, m.Pos[1]-y))
		}
	}
	for id, t := range p.evPrevT {
		if t != now {
			delete(p.evPrevT, id)
			delete(p.evPrevHP, id)
		}
	}
	// beams: a laser or the first jump of a lightning arc, fired by a listed mech, that ends on another listed mech
	if p.evDbg {
		for i := range o.Beams {
			bm := &o.Beams[i]
			v, w := b.plusBeamUnit(o, bm, x, y, zc)
			nd := 1e9
			if len(bm.Path) >= 2 {
				e := bm.Path[len(bm.Path)-1]
				if bm.Kind == "lightning" {
					e = bm.Path[1]
				}
				for j := range o.Mechs {
					if o.Mechs[j].ID != bm.By {
						nd = math.Min(nd, hyp(e[0]-o.Mechs[j].Pos[0], e[1]-o.Mechs[j].Pos[1]))
					}
				}
			}
			fmt.Fprintf(os.Stderr, "gpdbg beam t=%.1f by=%d kind=%s n=%d nearestMech=%.1f unit=%d/%d quiet=%v\n", now, bm.By, bm.Kind, len(bm.Path), nd, v, w, quiet)
		}
	}
	if !quiet {
		for i := range o.Beams {
			if v, w := b.plusBeamUnit(o, &o.Beams[i], x, y, zc); w > 0 {
				p.evUnits = append(p.evUnits, evUnit{now, v, w})
				if p.evLogged < 300 && os.Getenv("HAMSTER_LOG") != "" {
					p.evLogged++
					fmt.Fprintf(os.Stderr, "gpev t=%.1f w=%d victim=%d beam=%s by=%d\n", now, w, v, o.Beams[i].Kind, o.Beams[i].By)
				}
			}
		}
	}
	// evidloss: a mech losing plusEvidLossSum within plusEvidLossWin s to others (a large-loss signal, with
	// the same exclusions as above)
	if p.cfg.EvidLoss {
		k := 0
		sum := map[int]int{}
		for _, u := range p.evLoss {
			if now-u.t <= plusEvidLossWin {
				p.evLoss[k] = u
				k++
				sum[u.victim] += u.w
				if sum[u.victim] >= plusEvidLossSum {
					p.plusLatch(b, now, fmt.Sprintf("loss: victim %d lost %d in %.0f s", u.victim, sum[u.victim], plusEvidLossWin))
					return
				}
			}
		}
		p.evLoss = p.evLoss[:k]
	}
	// add up per victim over the window
	k := 0
	for _, u := range p.evUnits {
		if now-u.t <= plusEvidWindow {
			p.evUnits[k] = u
			k++
		}
	}
	p.evUnits = p.evUnits[:k]
	score := map[int]int{}
	for _, u := range p.evUnits {
		score[u.victim] += u.w
		if score[u.victim] >= p.evK {
			p.plusLatch(b, now, fmt.Sprintf("victim %d score %d", u.victim, score[u.victim]))
			return
		}
	}
}

// plusLatch: the evid latch (or, with evidshadow only, its log).
func (p *plusState) plusLatch(b *Brain, now float64, cause string) {
	if p.cfg.Evid {
		b.notPractice = true
		p.ffa = true
	}
	p.evidAt = now
	p.evidCause = cause
	if os.Getenv("HAMSTER_LOG") != "" {
		fmt.Fprintf(os.Stderr, "gpev LATCH t=%.1f %s\n", now, p.evidCause)
	}
}

// plusDroneSum: can the loss be a sum of drone bullets (25 each, 37.5 from behind)?
func plusDroneSum(step float64) bool {
	for k := 0; k <= 3; k++ { // armour upgrades: -8% damage taken each, up to 3
		f := 1 - 0.08*float64(k)
		for i := 0; i <= 4; i++ {
			for j := 0; j <= 3; j++ {
				if i+j > 0 && math.Abs(step-(25*float64(i)+37.5*float64(j))*f) < 0.6 {
					return true
				}
			}
		}
	}
	return false
}

// plusOnAimLine: could m have been hit by fire aimed at us? True when m is within plusEvidLineR of us while any
// mech aims at us, or within plusEvidLineR of the aim line (to 300 m) of a mech that aims at us.
func (b *Brain) plusOnAimLine(o *Obs, m *MechSeen, x, y float64) bool {
	p := &b.px
	if len(p.evAimers) > 0 && hyp(m.Pos[0]-x, m.Pos[1]-y) < plusEvidLineR {
		return true
	}
	for _, i := range p.evAimers {
		s := &o.Mechs[i]
		if s.ID == m.ID {
			continue
		}
		dx, dy := math.Cos(s.Aim[0]), math.Sin(s.Aim[0])
		rx, ry := m.Pos[0]-s.Pos[0], m.Pos[1]-s.Pos[1]
		along := rx*dx + ry*dy
		if along > -5 && along < 300 && math.Abs(rx*dy-ry*dx) < plusEvidLineR {
			return true
		}
	}
	return false
}

// plusBeamUnit: a laser beam (weight plusEvidLaserW) or the first jump of a lightning arc (weight plusEvidArcW) of a
// mech that is not us, ending on a listed mech that is neither us nor the shooter, inside the circle, on a line that
// does not pass within plusEvidLineR of us (a beam aimed at us that hit a mech on the way does not count), on a mech
// that is not on the aim line of a mech aiming at us, and not on a mech we hit in the last 0.5 s.
// Returns the victim's id and the weight (0 = no unit).
func (b *Brain) plusBeamUnit(o *Obs, bm *Beam, x, y float64, zc circle) (int, int) {
	if bm.By == o.Self.ID || len(bm.Path) < 2 {
		return 0, 0
	}
	w := 0
	switch bm.Kind {
	case "laser":
		w = plusEvidLaserW
	case "lightning":
		w = plusEvidArcW
	default:
		return 0, 0
	}
	a, e := bm.Path[0], bm.Path[1]
	if bm.Kind == "laser" {
		e = bm.Path[len(bm.Path)-1]
	}
	dx, dy := e[0]-a[0], e[1]-a[1]
	l := hyp(dx, dy)
	if l < 1 || math.Abs((x-a[0])*dy-(y-a[1])*dx)/l < plusEvidLineR || hyp(e[0]-x, e[1]-y) < plusEvidLineR {
		return 0, 0
	}
	for i := range o.Mechs {
		m := &o.Mechs[i]
		if m.Kind != "mech" || m.ID == bm.By || m.ID == o.Self.ID {
			continue
		}
		sc := b.scaleOf(m.Cubes)
		r, h := b.Cfg.Mech.Radius*sc+1.5, b.Cfg.Mech.Height*sc
		if hyp(e[0]-m.Pos[0], e[1]-m.Pos[1]) > r || e[2] < m.Pos[2]-1 || e[2] > m.Pos[2]+h+1 {
			continue
		}
		if t := b.px.evMyHit[m.ID]; t > 0 && o.T-t < 0.5 {
			return 0, 0
		}
		if hyp(m.Pos[0]-zc.X, m.Pos[1]-zc.Y) > zc.R-3 || b.plusOnAimLine(o, m, x, y) {
			return 0, 0
		}
		return m.ID, w
	}
	return 0, 0
}

// hamsters: practice endgame. While the squad profile is on (practice), once the next zone circle has a radius of at
// most plusEndHideR metres, play the default (cautious, hiding) profile for the rest of the match: the zone collapse
// ranks the survivors, so staying alive is worth more than the last squad fights. HAMSTER_ENDHIDE sets the radius
// (metres, default 140); 0 or a negative value turns it off.
var plusEndHideR = func() float64 {
	if v, err := strconv.ParseFloat(strings.TrimSpace(os.Getenv("HAMSTER_ENDHIDE")), 64); err == nil {
		return v
	}
	return 140
}()

func (b *Brain) plusEndHide(o *Obs) {
	if b.pracOn && !b.px.endHideOn && plusEndHideR > 0 && o.Zone.NextRadius <= plusEndHideR {
		b.px.endHideOn = true
		b.P = b.base
		b.P.Practice = false
	}
}
