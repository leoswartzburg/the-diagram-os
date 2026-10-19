// Word of the day — a curated advanced-vocabulary list, rotated 2x/day (morning + night). Curated
// (not LLM-generated) so definitions + pronunciations are always accurate and words never repeat
// until the list cycles (~40+ days at 2/day). A mix of literary/reading and scientific words.
import { getWordOfDay, setWordOfDay } from './conversations'

export const VOCAB_WORDS: { word: string; pron: string; def: string }[] = [
  { word: 'Perspicacious', pron: 'per-spih-KAY-shus', def: 'having keen insight; discerning' },
  { word: 'Sanguine', pron: 'SANG-gwin', def: 'cheerfully optimistic, especially in a hard situation' },
  { word: 'Obdurate', pron: 'OB-dur-it', def: 'stubbornly refusing to change; unyielding' },
  { word: 'Ephemeral', pron: 'ih-FEM-er-ul', def: 'lasting a very short time; fleeting' },
  { word: 'Recondite', pron: 'REK-un-dyte', def: 'little known; abstruse, hard to grasp' },
  { word: 'Pellucid', pron: 'peh-LOO-sid', def: 'transparently clear in style or meaning' },
  { word: 'Inchoate', pron: 'in-KOH-it', def: 'just begun; not yet fully formed' },
  { word: 'Fecund', pron: 'FEK-und', def: 'highly fertile; intellectually productive' },
  { word: 'Munificent', pron: 'myoo-NIF-ih-sunt', def: 'extremely generous' },
  { word: 'Truculent', pron: 'TRUCK-yoo-lunt', def: 'eager to fight; aggressively defiant' },
  { word: 'Laconic', pron: 'luh-KON-ik', def: 'using very few words; terse' },
  { word: 'Prolix', pron: 'PROH-liks', def: 'tediously long-winded' },
  { word: 'Sedulous', pron: 'SEJ-oo-lus', def: 'diligent, persevering, careful' },
  { word: 'Fatuous', pron: 'FATCH-oo-us', def: 'silly and pointless; complacently foolish' },
  { word: 'Perfunctory', pron: 'per-FUNK-tuh-ree', def: 'done routinely, with minimal effort or care' },
  { word: 'Trenchant', pron: 'TREN-chunt', def: 'sharp, incisive, vigorously effective' },
  { word: 'Sagacious', pron: 'suh-GAY-shus', def: 'wise; shrewd in judgment' },
  { word: 'Mendacious', pron: 'men-DAY-shus', def: 'untruthful; given to lying' },
  { word: 'Intransigent', pron: 'in-TRAN-sih-junt', def: 'refusing to compromise; unyielding' },
  { word: 'Quotidian', pron: 'kwoh-TID-ee-un', def: 'ordinary, everyday, commonplace' },
  { word: 'Ineffable', pron: 'in-EF-uh-bul', def: 'too great or extreme to be expressed in words' },
  { word: 'Cogent', pron: 'KOH-junt', def: 'clear, logical, and convincing' },
  { word: 'Diaphanous', pron: 'dy-AF-uh-nus', def: 'light, delicate, and translucent' },
  { word: 'Insidious', pron: 'in-SID-ee-us', def: 'proceeding harmfully in a subtle, stealthy way' },
  { word: 'Prescient', pron: 'PRESH-unt', def: 'having foreknowledge; seeing ahead' },
  { word: 'Refractory', pron: 'rih-FRAK-tuh-ree', def: 'stubbornly resistant to control or, in science, to heat/treatment' },
  { word: 'Nascent', pron: 'NAY-sunt', def: 'just coming into existence; emerging' },
  { word: 'Salubrious', pron: 'suh-LOO-bree-us', def: 'health-giving; wholesome' },
  { word: 'Viscous', pron: 'VIS-kus', def: 'thick and sticky; slow to flow' },
  { word: 'Labile', pron: 'LAY-bile', def: 'easily altered; unstable (chemically or emotionally)' },
  { word: 'Empirical', pron: 'em-PEER-ih-kul', def: 'based on observation or experiment, not theory alone' },
  { word: 'Isotropic', pron: 'eye-suh-TROH-pik', def: 'having identical properties in all directions' },
  { word: 'Stochastic', pron: 'stoh-KAS-tik', def: 'randomly determined; governed by probability' },
  { word: 'Ubiquitous', pron: 'yoo-BIK-wih-tus', def: 'present everywhere at once' },
  { word: 'Anomalous', pron: 'uh-NOM-uh-lus', def: 'deviating from what is standard or expected' },
  { word: 'Attenuate', pron: 'uh-TEN-yoo-ate', def: 'to reduce in force, intensity, or value' },
  { word: 'Nebulous', pron: 'NEB-yoo-lus', def: 'vague, hazy, ill-defined' },
  { word: 'Enervate', pron: 'EN-er-vate', def: 'to drain of energy or vitality' },
  { word: 'Obfuscate', pron: 'OB-fus-kate', def: 'to deliberately make unclear or confusing' },
  { word: 'Palliate', pron: 'PAL-ee-ate', def: 'to ease without curing; to make less severe' },
  { word: 'Recalcitrant', pron: 'rih-KAL-sih-trunt', def: 'obstinately uncooperative; hard to manage' },
  { word: 'Torpid', pron: 'TOR-pid', def: 'sluggish, dormant, lacking energy' },
  { word: 'Ossify', pron: 'OSS-ih-fye', def: 'to harden into bone; to become rigidly fixed' },
  { word: 'Desiccate', pron: 'DESS-ih-kate', def: 'to dry out thoroughly' },
  { word: 'Nadir', pron: 'NAY-deer', def: 'the lowest point' },
  { word: 'Zenith', pron: 'ZEE-nith', def: 'the highest point; culmination' },
  { word: 'Panacea', pron: 'pan-uh-SEE-uh', def: 'a supposed cure-all' },
  { word: 'Iconoclast', pron: 'eye-KON-uh-klast', def: 'one who attacks cherished beliefs or institutions' },
  { word: 'Polymath', pron: 'POL-ee-math', def: 'a person of wide-ranging, deep knowledge' },
  { word: 'Apocryphal', pron: 'uh-POK-rih-ful', def: 'of dubious authenticity though widely circulated' },
  { word: 'Erudite', pron: 'AIR-yoo-dite', def: 'having or showing deep, scholarly learning' },
  { word: 'Fastidious', pron: 'fa-STID-ee-us', def: 'meticulous; hard to please about detail' },
  { word: 'Gregarious', pron: 'grih-GAIR-ee-us', def: 'sociable; fond of company' },
  { word: 'Insipid', pron: 'in-SIP-id', def: 'lacking flavor, vigor, or interest' },
  { word: 'Juxtapose', pron: 'JUK-stuh-pohz', def: 'to place side by side for contrast' },
  { word: 'Meticulous', pron: 'muh-TIK-yoo-lus', def: 'showing great, precise attention to detail' },
  { word: 'Nefarious', pron: 'nih-FAIR-ee-us', def: 'wicked; villainous' },
  { word: 'Ostensible', pron: 'oh-STEN-sih-bul', def: 'stated or appearing to be true, but perhaps not' },
  { word: 'Paucity', pron: 'PAW-sih-tee', def: 'smallness of quantity; scarcity' },
  { word: 'Quiescent', pron: 'kwee-ESS-unt', def: 'in a state of quiet inactivity; dormant' },
  { word: 'Reticent', pron: 'RET-ih-sunt', def: 'reserved; reluctant to speak' },
  { word: 'Spurious', pron: 'SPYOOR-ee-us', def: 'false or fake; not genuine' },
  { word: 'Taciturn', pron: 'TASS-ih-turn', def: 'habitually silent or uncommunicative' },
  { word: 'Vociferous', pron: 'voh-SIF-er-us', def: 'loud and insistent in expressing opinion' },
  { word: 'Winnow', pron: 'WIN-oh', def: 'to sift out the good from the bad; to narrow down' },
  { word: 'Abstruse', pron: 'ab-STROOS', def: 'difficult to understand; obscure' },
  { word: 'Byzantine', pron: 'BIZ-un-teen', def: 'excessively complicated and intricate' },
  { word: 'Capricious', pron: 'kuh-PRISH-us', def: 'given to sudden, unpredictable changes' },
  { word: 'Deleterious', pron: 'del-ih-TEER-ee-us', def: 'harmful, damaging' },
  { word: 'Efficacious', pron: 'ef-ih-KAY-shus', def: 'effective in producing the intended result' },
  { word: 'Ferment', pron: 'FUR-ment', def: 'a state of agitation or unrest; to stir up' },
  { word: 'Hegemony', pron: 'hih-JEM-uh-nee', def: 'dominance of one group or state over others' },
  { word: 'Immutable', pron: 'ih-MYOO-tuh-bul', def: 'unchanging over time; unalterable' },
  { word: 'Jejune', pron: 'jih-JOON', def: 'naive and simplistic; insubstantial' },
  { word: 'Kinetic', pron: 'kih-NET-ik', def: 'relating to or produced by motion' },
  { word: 'Latent', pron: 'LAY-tunt', def: 'present but not yet visible or active' },
  { word: 'Magnanimous', pron: 'mag-NAN-ih-mus', def: 'generous and forgiving, especially toward a rival' },
  { word: 'Obviate', pron: 'OB-vee-ate', def: 'to remove a need or difficulty; to prevent' },
  { word: 'Precipitate', pron: 'prih-SIP-ih-tate', def: 'to cause to happen abruptly; hasty (adj.)' },
  { word: 'Redolent', pron: 'RED-uh-lunt', def: 'strongly reminiscent or suggestive of; fragrant' },
]

// Look up the pronunciation for a stored word (words are always drawn from this list).
export function pronFor(word: string): string {
  return VOCAB_WORDS.find(w => w.word.toLowerCase() === word.toLowerCase())?.pron ?? ''
}

// Advance the rotation by one word (called at the morning and night checkpoints → 2/day).
// The cursor persists in scribe_meta, so words don't repeat until the whole list has cycled.
export function advanceWord(): void {
  const cur = getWordOfDay()
  const idx = Number.isFinite(cur.idx) && cur.idx >= 0 ? cur.idx : 0
  const pick = VOCAB_WORDS[idx % VOCAB_WORDS.length]
  if (pick) setWordOfDay(pick.word, pick.def, idx + 1)
}
