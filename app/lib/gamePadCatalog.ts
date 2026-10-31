import type { ButtonKey, TriggerKey } from './gamepad';

export type GamePadId = 'brotato' | 'balatro' | 'spire' | 'hades' | 'terraria' | 'isaac'
  | 'hollow' | 'celeste' | 'deadcells' | 'dave' | 'dredge' | 'lamb';
type ActionButton = Extract<ButtonKey, 'a' | 'b' | 'x' | 'y' | 'lb' | 'rb' | 'select' | 'start'>;
export type GameAction = { key: ActionButton; kind: 'button'; glyph: string; label: string } | { key: TriggerKey; kind: 'trigger'; glyph: string; label: string };
const b = (key: ActionButton, label: string): GameAction => ({ key, kind: 'button', glyph: key === 'start' ? 'Start' : key.toUpperCase(), label });
const t = (key: TriggerKey, label: string): GameAction => ({ key, kind: 'trigger', glyph: key.toUpperCase(), label });
export const GAME_PADS: Record<GamePadId, { title: string; layout: 'one' | 'combat' | 'twin'; art: string; glow: string; hint: string; actions: GameAction[] }> = {
  hollow: { title: 'Hollow Knight', layout: 'combat', art: 'Moonlit underground kingdom', glow: '#82aaca',
    hint: 'For the original Hollow Knight. Separate jump, attack and focus targets support simultaneous movement and holds. Buttons keep their Xbox identity; check your in-game bindings before playing.',
    actions: [b('a','Jump'),b('x','Attack'),b('b','Focus / Cast'),t('rt','Dash'),t('lt','Super dash'),b('y','Dream nail'),b('lb','Map'),b('rb','Quick cast'),b('select','Inventory'),b('start','Pause')] },
  celeste: { title: 'Celeste', layout: 'combat', art: 'Alpine sunset', glow: '#be9ed4',
    hint: 'Jump, dash and grab controls with independent holds for climbing. All inputs remain ordinary Xbox buttons; match grab and alternate actions to your in-game bindings. No automatic jumps or timing macros.',
    actions: [b('a','Jump'),b('x','Dash'),b('b','Dash / B'),b('lb','Grab / LB'),b('rb','Grab / RB'),b('y','Y'),t('lt','LT'),t('rt','RT'),b('select','Journal / View'),b('start','Pause')] },
  deadcells: { title: 'Dead Cells', layout: 'combat', art: 'Ruined island fortress', glow: '#79b5ae',
    hint: 'Large weapon, jump and roll targets with separate skill triggers. Holds pass through normally. Match these Xbox buttons to your selected controller bindings, including heal and interact.',
    actions: [b('x','Weapon 1'),b('y','Weapon 2'),b('b','Roll'),b('a','Jump'),t('lt','Skill / LT'),t('rt','Skill / RT'),b('lb','Heal / LB'),b('rb','Interact / RB'),b('select','Map'),b('start','Pause')] },
  dave: { title: 'Dave the Diver', layout: 'twin', art: 'Sunlit blue reef', glow: '#59bdce',
    hint: 'Movement and a second stick for game contexts that use it, with both triggers available for aiming and tools. Diving, restaurant work and minigames change the prompts: follow the displayed Xbox letters. No rapid-tap automation.',
    actions: [t('lt','LT'),b('lb','LB'),b('rb','RB'),t('rt','RT'),b('x','Action / X'),b('a','Confirm / A'),b('b','Back / B'),b('y','Action / Y'),b('select','View'),b('start','Menu')] },
  dredge: { title: 'Dredge', layout: 'twin', art: 'Fogbound fishing harbor', glow: '#b49b70',
    hint: 'Separate steering and camera sticks, plus every face and shoulder button for fishing, cargo and abilities. Follow the game’s current Xbox prompts; fishing timing stays entirely under your control.',
    actions: [b('lb','LB'),t('lt','LT'),t('rt','RT'),b('rb','RB'),b('a','Confirm / A'),b('b','Back / B'),b('x','Action / X'),b('y','Action / Y'),b('select','View'),b('start','Pause')] },
  lamb: { title: 'Cult of the Lamb', layout: 'combat', art: 'Candlelit forest shrine', glow: '#bf8176',
    hint: 'Separate attack, dodge, curse and interaction targets for crusades and camp life. Held inputs remain independent of movement. Follow your in-game Xbox mappings for contextual and shoulder actions.',
    actions: [b('x','Attack'),b('b','Dodge'),b('y','Curse'),b('a','Interact'),t('lt','LT'),t('rt','RT'),b('lb','LB'),b('rb','RB'),b('select','View'),b('start','Pause')] },
  brotato: { title: 'Brotato', layout: 'one', art: 'Alien wasteland', glow: '#a0bd60',
    hint: 'One-handed movement with auto-aim enabled in the game. Shop actions follow the game’s button prompts. Use Current controls if you prefer manual aiming.',
    actions: [b('a','Select'),b('b','Back'),b('start','Pause'),b('x','Shop action'),b('y','Shop action'),b('lb','Shop / LB'),b('rb','Shop / RB')] },
  balatro: { title: 'Balatro', layout: 'one', art: 'Midnight casino', glow: '#6b9f95',
    hint: 'One-handed card navigation. Separate X and Y targets for playing and discarding; shoulder buttons remain available for sorting and contextual actions. Follow the game’s prompts.',
    actions: [b('a','Select'),b('b','Back'),b('start','Menu'),b('x','Play hand'),b('y','Discard'),b('lb','Sort / LB'),b('rb','Sort / RB')] },
  spire: { title: 'Slay the Spire', layout: 'one', art: 'Emerald tower', glow: '#79aa91',
    hint: 'For the original Slay the Spire. Navigate cards with the stick. End Turn has its own target; enable the game’s hold-to-end-turn option if preferred. This does not add a macro.',
    actions: [b('a','Confirm'),b('b','Back'),b('start','Menu'),b('x','Inspect / X'),b('y','End turn'),b('lb','Panel / LB'),b('rb','Panel / RB')] },
  hades: { title: 'Hades / Hades II', layout: 'combat', art: 'Obsidian underworld', glow: '#c17058',
    hint: 'Large attack, special, cast and dash targets. Holds pass through for charged actions. Shoulder and trigger inputs retain their Xbox identity; their actions differ between the two games.',
    actions: [b('x','Attack'),b('y','Special'),b('b','Cast'),b('a','Dash'),t('rt','Interact / RT'),t('lt','Call / Hex'),b('lb','LB'),b('rb','RB'),b('select','View'),b('start','Pause')] },
  terraria: { title: 'Terraria', layout: 'twin', art: 'Crystal caverns', glow: '#6e9fbd',
    hint: 'Two sticks for movement and aiming, with the full face/shoulder controls available. Terraria has several controller profiles: match the on-screen Xbox prompts to your selected profile before playing.',
    actions: [t('lt','LT'),b('lb','Previous / LB'),b('rb','Next / RB'),t('rt','Use / RT'),b('a','A'),b('b','B'),b('x','X'),b('y','Y'),b('select','View'),b('start','Menu')] },
  isaac: { title: 'The Binding of Isaac', layout: 'twin', art: 'Candlelit dungeon', glow: '#ad8a63',
    hint: 'Move with the left stick and fire with the right. Face buttons provide directional firing too. Shoulder and trigger controls remain available for items, bombs, cards and map; follow your game’s binding settings.',
    actions: [b('lb','Item / LB'),b('rb','Bomb / RB'),t('lt','LT'),t('rt','Card / RT'),b('a','Fire down'),b('b','Fire right'),b('x','Fire left'),b('y','Fire up'),b('select','Map'),b('start','Pause')] },
};
export const GAME_PAD_IDS = Object.keys(GAME_PADS) as GamePadId[];
export function isGamePadId(id: unknown): id is GamePadId {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(GAME_PADS, id);
}
