package mech

// giddyplus: changes to the FREE-FOR-ALL play only (see ../NOTICE).
//
// Every rule here is gated twice: by b.px.ffa and by one switch. b.px.ffa is true only when the upstream latch
// b.notPractice ("a mech died that I did not kill") was set before plusLatchBy seconds. In a free-for-all the first
// death comes at 8 to 29 s; in a practice match a house bot can die in the zone late in the match, which also sets the
// upstream latch, and from then on upstream plays its default profile: that case must stay exactly upstream, so a
// latch after plusLatchBy leaves every rule off. The practice/"squad" profile and everything before the latch run
// exactly as upstream in every case. The switches
// come from the environment variable GIDDYPLUS, a comma-separated list (for example "duel,late"); "all" turns every
// switch on, "none" or an empty value turns every switch off (= upstream behaviour). When the variable is not set
// or is "default" the switches are plusDefault below.
//
//	duel   leave a fight that is being lost: more than plusDuelLoss of max HP gone in 3 s and the target not weaker
//	multi  two different mechs hit us within 4 s, or a mech we cannot see hit us while we have a target: take cover
//	low    retreat at plusLowHP instead of 0.38 while more than 4 are alive (stay above the 350 HP trigger of copies)
//	late   end-game: keep retreat and hiding until 2 are alive; with 3 or 4 alive do not open on a mech inside 60 m
//	       that has more HP and looks at us; do not walk to the centre when the 25 m circle is announced
//	quiet  after the latch and before plusQuietUntil s: engage only a mech that hit us, is inside 35 m or is nearly
//	       dead; take cover when a mech has a line on us (upstream's EarlyHide rule)
//	grow   from plusGrowFrom s: crates and drones all match, loot radius 130 m (upstream: 90 m, crates until 150 s)
//	drops  from plusGrowFrom s: take a supply drop when no mech was seen near it
//	shy    upstream's unused Shy rule at plusShyDist: a mech between 60 m and that distance that closes on us or
//	       aims at us, and is not a target, makes us step out of its sight
//	alert  upstream's unused Alert rule at plusAlertDist: such a mech is a target at once (we shoot first)
//	odds   upstream's unused OddsFlee rule at plusOddsFlee: leave a target against which upstream's own
//	       win estimate (HP, cubes, weapons, who is busy) is below that value
//	evid   THE ONE SWITCH THAT ACTS BEFORE THE FIRST DEATH: it sets upstream's latch b.notPractice as soon as the bot
//	       has watched mechs shoot each other (see plusEvid). In practice the 15 house bots never fight each other,
//	       so it must never fire there; when it does not fire the bot is upstream.
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
	EvidShadow                                 bool // evid computed and logged, never latched (measuring only)
}

// The configuration that ships when GIDDYPLUS is not set.
var plusDefault = plusCfg{}

const (
	plusLatchBy    = 60.0 // the upstream latch must come before this time for any rule here to be active
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
	plusAlertDist  = 110.0
	plusOddsFlee   = 0.35

	// evid (see plusEvid)
	plusEvidUntil   = 60.0 // no evidence is collected after this time
	plusEvidGunLo   = 38.0 // a one-observation HP loss in [GunLo, GunHi] is "gun-like" (one or two bullets)
	plusEvidGunHi   = 100.0
	plusEvidLaser   = 100.0 // with a laser beam ending on the mech: "laser-like"
	plusEvidWindow  = 6.0   // seconds over which unit events are added up
	plusEvidScore   = 6     // latch when one victim has gun-like + 3 x laser-like >= this within the window
	plusEvidNpcNear = 70.0  // a mech with a known drone this near is ignored (drone bullets)
	plusEvidQuiet   = 2.0   // seconds after any sign that we are being attacked during which nothing counts
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
	evUnits           []evUnit
	fireAt, attackAt  float64
	mortarAt          float64
	evidAt, deathAt   float64
	evidCause         string
	evLogged          int
	// counters for the optional log line
	nDuel, nMulti, nUnseen, nShy, nQuiet, nHold, nDrop int
	ffaAt                                              float64
	endHideOn                                          bool // hamsters: practice endgame switch fired (plusEndHide)
}

type evUnit struct {
	t      float64
	victim int
	w      int // 1 gun-like, 3 laser-like
}

func loadPlus() plusCfg {
	v, ok := os.LookupEnv("GIDDYPLUS")
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
		case "evidshadow":
			c.EvidShadow = true
		}
	}
	return c
}

func (b *Brain) plusInit() {
	c := loadPlus()
	b.px = plusState{cfg: c, hitBy: map[int]float64{}, unseenAt: -100, fleeUntil: -100, ffaAt: -1, latchAt: -1,
		evPrevHP: map[int]float64{}, evPrevT: map[int]float64{}, evMyHit: map[int]float64{}, fireAt: -100, attackAt: -100,
		mortarAt: -100, evidAt: -1, deathAt: -1}
	b.px.any = c != plusCfg{}
	b.px.behave = c != plusCfg{Evid: c.Evid, EvidShadow: c.EvidShadow}
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
		p.deathAt = now // when upstream's own evidence (a death that is not our kill) first shows
	}
	if b.notPractice && p.latchAt < 0 {
		p.latchAt = now
		p.ffa = now < plusLatchBy
	}
	if !p.ffa || b.pracOn || b.openOn {
		return
	}
	if !p.behave {
		return // only measuring switches are on (evidshadow): leave b.P exactly as upstream set it
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

// plusLate replaces upstream's "late" (next radius <= 70 m or 3 alive: never retreat, never hide).
func (b *Brain) plusLate(late bool, o *Obs) bool {
	if !b.plusOn(b.px.cfg.Late) {
		return late
	}
	return o.Alive <= 2
}

// plusEngage edits upstream's decision "this mech is a target" for one visible mech (Ghost profile only).
func (b *Brain) plusEngage(t *Track, o *Obs, shy **Track) {
	if !b.px.ffa || !t.Engage {
		return
	}
	me := &o.Self
	now := o.T
	hitMe := now-t.HitMe < 4
	weak := t.HP < 350 && t.Dist < 120
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

// plusFlee: true while the bot should count as "swamped" (upstream then goes to cover until HP > 80 %).
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

// plusCover: upstream's cover search. With duel or multi on (free-for-all only) it also hides from the bearing of
// the last hit when the shooter is not seen, instead of walking to the zone goal as upstream does in that case.
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
	return b.plusOn(b.px.cfg.Late) && o.Zone.NextRadius <= 30 && o.Alive > 2
}

func (b *Brain) plusHome(o *Obs) (float64, float64, bool) {
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

// plusDropOK: the extra conditions for walking to a supply drop (upstream's own conditions still apply).
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

// PlusLog is one line for stderr at the end of a match (only printed when GIDDYPLUS_LOG is set).
func (b *Brain) PlusLog() string {
	p := &b.px
	return fmt.Sprintf("giddyplus cfg=%+v evidAt=%.1f cause=%q deathAt=%.1f latchAt=%.1f ffaAt=%.1f duel=%d multi=%d unseen=%d shy=%d quiet=%d hold=%d dropTicks=%d panics=%d",
		p.cfg, p.evidAt, p.evidCause, p.deathAt, p.latchAt, p.ffaAt, p.nDuel, p.nMulti, p.nUnseen, p.nShy, p.nQuiet, p.nHold, p.nDrop, b.Panics)
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
//   - laser-like: a loss of at least plusEvidLaser together with a laser beam of a third mech that ends on it, weight 3.
//
// Nothing counts
//   - after plusEvidUntil seconds, or once the latch is set;
//   - when we hit that mech in the last 0.4 s or pulled any trigger in the last 1.5 s (our own shots);
//   - for plusEvidQuiet seconds after a sign that we are the one being attacked: we took damage from a mech, a bullet
//     or shell is flying at us, or a listed mech aims at us (a hunter that shoots at us can hit a house bot standing
//     in between);
//   - for a mech that holds a mortar, or while a mortar shell is in sight or was in the last 3 s (splash damage);
//   - for a mech outside the circle (zone damage), or with a known drone within plusEvidNpcNear metres;
//   - when the previous sample of that mech is older than one observation step.
//
// The latch is set when one victim collects a weight of plusEvidScore within plusEvidWindow seconds: that is six gun
// hits, or two laser hits, or a laser hit and three gun hits, on the same mech, none of them ours.
func (b *Brain) plusEvid(o *Obs) {
	p := &b.px
	if !p.cfg.Evid && !p.cfg.EvidShadow {
		return
	}
	now := o.T
	// shadow: keep collecting after upstream's own latch, stop at our first latch (which is only logged)
	if (p.cfg.Evid && b.notPractice) || p.evidAt >= 0 || now > plusEvidUntil {
		return
	}
	me := &o.Self
	x, y := me.Pos[0], me.Pos[1]
	for i := range o.Events {
		e := &o.Events[i]
		switch e.Type {
		case "hit":
			p.evMyHit[e.Target] = now
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
	for i := range o.Mechs {
		m := &o.Mechs[i]
		if m.Kind != "mech" {
			continue
		}
		d := hyp(m.Pos[0]-x, m.Pos[1]-y)
		if d < 250 && math.Abs(angDiff(m.Aim[0], math.Atan2(y-m.Pos[1], x-m.Pos[0]))) < 0.25 {
			p.attackAt = now
		}
		if holds(m.Weapons, "mortar") {
			p.mortarAt = now // a mortar carrier is listed: its splash can explain any loss near it
		}
	}
	quiet := now-p.attackAt < plusEvidQuiet || now-p.fireAt < 1.5 || now-p.mortarAt < 3
	zc := b.curZone(&o.Zone)
	for i := range o.Mechs {
		m := &o.Mechs[i]
		if m.Kind != "mech" || m.MaxHP <= 0 {
			continue
		}
		prevHP, okH := p.evPrevHP[m.ID]
		prevT := p.evPrevT[m.ID]
		p.evPrevHP[m.ID], p.evPrevT[m.ID] = m.HP, now
		if !okH || now-prevT > 0.125 || quiet {
			continue
		}
		step := prevHP - m.HP
		if step < plusEvidGunLo {
			continue
		}
		if now-p.evMyHit[m.ID] < 0.4 && p.evMyHit[m.ID] > 0 {
			continue
		}
		if holds(m.Weapons, "mortar") || hyp(m.Pos[0]-zc.X, m.Pos[1]-zc.Y) > zc.R-3 {
			continue
		}
		npcNear := false
		for _, n := range b.npcs {
			if hyp(n.Pos[0]-m.Pos[0], n.Pos[1]-m.Pos[1]) < plusEvidNpcNear {
				npcNear = true
				break
			}
		}
		if npcNear {
			continue
		}
		w := 0
		switch {
		case step <= plusEvidGunHi:
			if plusDroneSum(step) {
				continue
			}
			w = 1
		case step >= plusEvidLaser:
			if b.plusBeamOn(o, m, x, y) {
				w = 3
			}
		}
		if w == 0 {
			continue
		}
		p.evUnits = append(p.evUnits, evUnit{now, m.ID, w})
		if p.evLogged < 300 && os.Getenv("GIDDYPLUS_LOG") != "" {
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
		if score[u.victim] >= plusEvidScore {
			if p.cfg.Evid {
				b.notPractice = true
			}
			p.evidAt = now
			p.evidCause = fmt.Sprintf("victim %d score %d", u.victim, score[u.victim])
			if os.Getenv("GIDDYPLUS_LOG") != "" {
				fmt.Fprintf(os.Stderr, "gpev LATCH t=%.1f %s\n", now, p.evidCause)
			}
			return
		}
	}
}

// plusDroneSum: can the loss be a sum of drone bullets (25 each, 37.5 from behind)?
func plusDroneSum(step float64) bool {
	for i := 0; i <= 4; i++ {
		for j := 0; j <= 3; j++ {
			if i+j > 0 && math.Abs(step-25*float64(i)-37.5*float64(j)) < 0.3 {
				return true
			}
		}
	}
	return false
}

// plusBeamOn: did a third mech's laser beam end on m, on a line that does not pass near us?
func (b *Brain) plusBeamOn(o *Obs, m *MechSeen, x, y float64) bool {
	sc := b.scaleOf(m.Cubes)
	r, h := b.Cfg.Mech.Radius*sc+1.5, b.Cfg.Mech.Height*sc
	for i := range o.Beams {
		bm := &o.Beams[i]
		if bm.Kind != "laser" || bm.By == m.ID || bm.By == o.Self.ID || len(bm.Path) < 2 {
			continue
		}
		a, e := bm.Path[0], bm.Path[len(bm.Path)-1]
		if hyp(e[0]-m.Pos[0], e[1]-m.Pos[1]) > r || e[2] < m.Pos[2]-1 || e[2] > m.Pos[2]+h+1 {
			continue
		}
		dx, dy := e[0]-a[0], e[1]-a[1]
		l := hyp(dx, dy)
		if l < 1 {
			continue
		}
		// distance from us to the beam's line (extended): a beam aimed at us that hit m on the way does not count
		if math.Abs((x-a[0])*dy-(y-a[1])*dx)/l < 15 {
			continue
		}
		return true
	}
	return false
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

// hamsters: optional squad-profile overrides for practice variants. HAMSTER_SQUAD_HPW and HAMSTER_SQUAD_LETHALK replace
// HPw and LethalK of squadParams when set to a number; unset leaves the profile exactly as written in brain.go.
func plusEnvFloat(name string) (float64, bool) {
	v, err := strconv.ParseFloat(strings.TrimSpace(os.Getenv(name)), 64)
	return v, err == nil
}

var plusSquadHPw, plusSquadHPwSet = plusEnvFloat("HAMSTER_SQUAD_HPW")
var plusSquadLethalK, plusSquadLethalKSet = plusEnvFloat("HAMSTER_SQUAD_LETHALK")

func plusSquadTune(p Params) Params {
	if plusSquadHPwSet {
		p.HPw = plusSquadHPw
	}
	if plusSquadLethalKSet {
		p.LethalK = plusSquadLethalK
	}
	return p
}
