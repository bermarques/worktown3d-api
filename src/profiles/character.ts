// What someone's character looks like (character customization). The web app draws it; the API stores it, checks
// it, and shares it with everyone who sees that person in a building (their desk character, and their player when
// they're there live).
import { IsIn, Matches } from 'class-validator';

export const HAIR_STYLES = ['short', 'spiky', 'bun', 'long', 'curly', 'bald'] as const;
export const EYES = ['round', 'dots', 'happy', 'sleepy', 'big'] as const;
export const GLASSES = ['none', 'round', 'square', 'shades'] as const;
export const HEADWEAR = ['none', 'headphones', 'cap', 'beanie', 'party'] as const;

const COLOR = /^#[0-9a-f]{6}$/i;
const color = (what: string) => ({ message: `${what} must be a color like #f1c27d` });
const oneOf = (what: string, list: readonly string[]) => ({ message: `${what} must be one of: ${list.join(', ')}` });

export interface Character {
  skin: string;
  hair: string;
  hairStyle: (typeof HAIR_STYLES)[number];
  eyes: (typeof EYES)[number];
  eyeColor: string;
  shirt: string;
  pants: string;
  glasses: (typeof GLASSES)[number];
  headwear: (typeof HEADWEAR)[number];
}

/** A whole character, as the customizer saves it. Colors are #rrggbb. */
export class CharacterDto implements Character {
  @Matches(COLOR, color('skin'))
  skin!: string;

  @Matches(COLOR, color('hair'))
  hair!: string;

  @IsIn(HAIR_STYLES, oneOf('hairStyle', HAIR_STYLES))
  hairStyle!: Character['hairStyle'];

  @IsIn(EYES, oneOf('eyes', EYES))
  eyes!: Character['eyes'];

  @Matches(COLOR, color('eyeColor'))
  eyeColor!: string;

  @Matches(COLOR, color('shirt'))
  shirt!: string;

  @Matches(COLOR, color('pants'))
  pants!: string;

  @IsIn(GLASSES, oneOf('glasses', GLASSES))
  glasses!: Character['glasses'];

  @IsIn(HEADWEAR, oneOf('headwear', HEADWEAR))
  headwear!: Character['headwear'];
}

/** The plain object to store (colors lower-cased). */
export function toCharacter(c: Character): Character {
  return {
    skin: c.skin.toLowerCase(),
    hair: c.hair.toLowerCase(),
    hairStyle: c.hairStyle,
    eyes: c.eyes,
    eyeColor: c.eyeColor.toLowerCase(),
    shirt: c.shirt.toLowerCase(),
    pants: c.pants.toLowerCase(),
    glasses: c.glasses,
    headwear: c.headwear,
  };
}

/** A stored character, or null if it isn't one any more (say, an option was removed): they get the default look. */
export function readCharacter(value: unknown): Character | null {
  const c = value as Partial<Record<keyof Character, unknown>> | null;
  if (!c || typeof c !== 'object') return null;
  const ok =
    [c.skin, c.hair, c.eyeColor, c.shirt, c.pants].every((v) => typeof v === 'string' && COLOR.test(v)) &&
    HAIR_STYLES.includes(c.hairStyle as Character['hairStyle']) &&
    EYES.includes(c.eyes as Character['eyes']) &&
    GLASSES.includes(c.glasses as Character['glasses']) &&
    HEADWEAR.includes(c.headwear as Character['headwear']);
  return ok ? toCharacter(c as Character) : null;
}
