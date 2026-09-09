import {
  format_log_entry,
  redact_log_fields,
  resolve_minimum_log_level,
  should_emit_log_level,
  REDACTED_VALUE_PLACEHOLDER,
  CYCLIC_VALUE_PLACEHOLDER,
  DEPTH_LIMIT_PLACEHOLDER,
  TRUNCATED_VALUE_SUFFIX,
  LOG_VALUE_LIMITS,
  type LogLevel,
  type StructuredLogEntry,
} from '../../../src/shared/logging/application_logger';

describe('should_emit_log_level', () => {
  it.each<[LogLevel, LogLevel, boolean]>([
    ['debug', 'debug', true],
    ['debug', 'info', false],
    ['info', 'warn', false],
    ['warn', 'warn', true],
    ['error', 'warn', true],
    ['error', 'error', true],
    ['warn', 'error', false],
  ])('%s sous un seuil %s : %s', (level, minimum_level, expected) => {
    expect(should_emit_log_level(level, minimum_level)).toBe(expected);
  });
});

describe('resolve_minimum_log_level', () => {
  it("en production on ne descend pas sous info : le debug y serait du bruit et un risque de fuite", () => {
    expect(resolve_minimum_log_level('production')).toBe('info');
  });

  it.each<['development' | 'test']>([['development'], ['test']])(
    'en %s le debug est emis',
    (node_environment) => {
      expect(resolve_minimum_log_level(node_environment)).toBe('debug');
    },
  );
});

describe('redact_log_fields', () => {
  // memories/observabilite.md : ne jamais journaliser un PIN ni un token en
  // clair, meme en cas d'echec. La meme regle vaut pour tout secret — les logs
  // sont lus par plus de monde que la base.
  it.each([
    'password',
    'plaintext_password',
    'demo_lawyer_password',
    'access_link_token_pepper',
    'internal_storage_webhook_secret',
    'Authorization',
    'COOKIE',
    'submitted_pin',
    'client_credential',
  ])('la valeur du champ %s est masquee', (field_name: string) => {
    const redacted = redact_log_fields({ [field_name]: 'valeur-tres-secrete' });

    expect(redacted[field_name]).toBe(REDACTED_VALUE_PLACEHOLDER);
    expect(JSON.stringify(redacted)).not.toContain('valeur-tres-secrete');
  });

  it('les champs anodins sont conserves tels quels', () => {
    const redacted = redact_log_fields({ email: 'demo@x.fr', attempts: 3, ok: true });

    expect(redacted).toEqual({ email: 'demo@x.fr', attempts: 3, ok: true });
  });

  it('le masquage descend dans les objets imbriques : un secret ne se cache pas en profondeur', () => {
    const redacted = redact_log_fields({
      request: { headers: { authorization: 'Bearer tres-secret' }, path: '/api/auth' },
    });

    expect(JSON.stringify(redacted)).not.toContain('tres-secret');
    expect(JSON.stringify(redacted)).toContain('/api/auth');
  });

  it('le masquage traverse les tableaux', () => {
    const redacted = redact_log_fields({
      attempts: [{ token: 'secret-1' }, { token: 'secret-2' }],
    });

    expect(JSON.stringify(redacted)).not.toContain('secret-1');
    expect(JSON.stringify(redacted)).not.toContain('secret-2');
  });

  it("une structure cyclique ne fait pas boucler le masquage : un log ne doit jamais tuer l'application", () => {
    const cyclic: Record<string, unknown> = { name: 'boucle' };
    cyclic.self = cyclic;

    expect(() => redact_log_fields({ cyclic })).not.toThrow();
  });
});

describe('format_log_entry', () => {
  const entry: StructuredLogEntry = {
    level: 'warn',
    message: 'quelque chose merite un oeil',
    context: 'database',
    timestamp: '2026-09-08T10:00:00.000Z',
    fields: { code: '25P01' },
  };

  it('rend une seule ligne de JSON : une collecte lit des lignes, pas une grammaire a deviner', () => {
    const formatted = format_log_entry(entry);

    expect(formatted).not.toContain('\n');
    expect(JSON.parse(formatted)).toEqual({
      level: 'warn',
      message: 'quelque chose merite un oeil',
      context: 'database',
      timestamp: '2026-09-08T10:00:00.000Z',
      fields: { code: '25P01' },
    });
  });

  it('un message contenant un saut de ligne ne casse pas le format ligne par ligne', () => {
    const formatted = format_log_entry({ ...entry, message: 'premiere\nseconde' });

    expect(formatted.split('\n')).toHaveLength(1);
    expect(JSON.parse(formatted).message).toBe('premiere\nseconde');
  });

  it('les champs sont masques a l ecriture, pas seulement a la construction', () => {
    const formatted = format_log_entry({
      ...entry,
      fields: { password: 'tres-secret' },
    });

    expect(formatted).not.toContain('tres-secret');
  });

  it('une entree sans champ reste valide', () => {
    const formatted = format_log_entry({ ...entry, fields: undefined });

    expect(JSON.parse(formatted).message).toBe(entry.message);
  });
});

// Ces cas etaient tous invisibles dans la suite, ce qui est la raison pour
// laquelle ils sont passes. Mesure sur l'implementation d'origine :
// une Error rendait `{}`, une Date rendait `{}`, et un BigInt faisait LEVER
// JSON.stringify — donc le logger tuait son appelant.
describe('redact_log_fields : les valeurs que Object.entries ne sait pas voir', () => {
  it("une Error conserve son nom, son message et sa pile : ils sont NON ENUMERABLES, donc invisibles a Object.entries", () => {
    const failure = new Error('la base est injoignable');

    const redacted = redact_log_fields({ cause: failure }) as {
      cause: { name: string; message: string; stack: string };
    };

    expect(redacted.cause.name).toBe('Error');
    expect(redacted.cause.message).toBe('la base est injoignable');
    expect(redacted.cause.stack).toContain('Error: la base est injoignable');
  });

  it('les proprietes posees sur une Error sont conservees, et masquees si leur nom l exige', () => {
    const failure = Object.assign(new Error('echec'), {
      code: 'ECONNREFUSED',
      password: 'tres-secret',
    });

    const redacted = redact_log_fields({ cause: failure }) as {
      cause: { code: string; password: string };
    };

    expect(redacted.cause.code).toBe('ECONNREFUSED');
    expect(redacted.cause.password).toBe(REDACTED_VALUE_PLACEHOLDER);
  });

  it('la chaine de causes est suivie', () => {
    const root_cause = new Error('socket fermee');
    const failure = new Error('requete echouee', { cause: root_cause });

    const redacted = redact_log_fields({ failure }) as {
      failure: { cause: { message: string } };
    };

    expect(redacted.failure.cause.message).toBe('socket fermee');
  });

  it("une chaine de causes cyclique ne fait pas boucler : a cause b, b cause a", () => {
    const first = new Error('premiere');
    const second = new Error('seconde', { cause: first });
    (first as { cause?: unknown }).cause = second;

    expect(() => redact_log_fields({ first })).not.toThrow();
    expect(JSON.stringify(redact_log_fields({ first }))).toContain(CYCLIC_VALUE_PLACEHOLDER);
  });

  it('une Date rend sa forme ISO plutot qu un objet vide', () => {
    const redacted = redact_log_fields({ at: new Date('2026-01-01T00:00:00.000Z') });

    expect(redacted.at).toBe('2026-01-01T00:00:00.000Z');
  });

  it('un Map et un Set rendent leur contenu', () => {
    const redacted = redact_log_fields({
      par_compte: new Map([['demo@x.fr', 3]]),
      adresses: new Set(['203.0.113.7']),
    });

    expect(redacted.par_compte).toEqual({ 'demo@x.fr': 3 });
    expect(redacted.adresses).toEqual(['203.0.113.7']);
  });

  it('les clefs sensibles d un Map sont masquees comme celles d un objet', () => {
    const redacted = redact_log_fields({ entrees: new Map([['password', 'tres-secret']]) });

    expect(JSON.stringify(redacted)).not.toContain('tres-secret');
  });

  it("un BigInt ne fait plus lever la serialisation : un log ne doit jamais tuer son appelant", () => {
    expect(() =>
      format_log_entry({
        level: 'info',
        message: 'm',
        context: 'c',
        timestamp: '2026-01-01T00:00:00.000Z',
        fields: { taille: 9007199254740993n },
      }),
    ).not.toThrow();

    expect(redact_log_fields({ taille: 42n }).taille).toBe('42');
  });

  it('un objet partage mais NON cyclique est rendu deux fois en entier', () => {
    const shared = { id: 1 };

    const redacted = redact_log_fields({ premier: shared, second: shared });

    expect(redacted).toEqual({ premier: { id: 1 }, second: { id: 1 } });
  });

  it("le suivi des ancetres repart de zero a chaque appel : un log ne doit pas empieter sur le suivant", () => {
    const shared = { id: 1 };

    redact_log_fields({ shared });
    const second_call = redact_log_fields({ shared });

    expect(second_call).toEqual({ shared: { id: 1 } });
  });
});

describe('redact_log_fields : bornes de taille', () => {
  it('la profondeur est bornee', () => {
    let deeply_nested: Record<string, unknown> = { fond: 'temoin-tout-au-fond' };
    for (let level = 0; level < LOG_VALUE_LIMITS.max_depth + 5; level += 1) {
      deeply_nested = { niveau: deeply_nested };
    }

    const formatted = JSON.stringify(redact_log_fields(deeply_nested));

    expect(formatted).toContain(DEPTH_LIMIT_PLACEHOLDER);
    expect(formatted).not.toContain('temoin-tout-au-fond');
  });

  it('un tableau trop long est tronque, et la troncature est dite', () => {
    const many_items = Array.from({ length: 10_000 }, (_value, index) => index);

    const redacted = redact_log_fields({ many_items }) as { many_items: unknown[] };

    expect(redacted.many_items.length).toBe(LOG_VALUE_LIMITS.max_array_items + 1);
    expect(String(redacted.many_items[LOG_VALUE_LIMITS.max_array_items])).toContain(
      TRUNCATED_VALUE_SUFFIX,
    );
  });

  it('un objet a trop de clefs est tronque', () => {
    const many_keys: Record<string, unknown> = {};
    for (let index = 0; index < 10_000; index += 1) {
      many_keys[`clef_${index}`] = index;
    }

    const redacted = redact_log_fields(many_keys);

    expect(Object.keys(redacted).length).toBeLessThanOrEqual(
      LOG_VALUE_LIMITS.max_object_keys + 1,
    );
  });

  it('une chaine demesuree est tronquee', () => {
    const redacted = redact_log_fields({ corps: 'a'.repeat(1_000_000) });

    expect(String(redacted.corps).length).toBeLessThan(
      LOG_VALUE_LIMITS.max_string_length + TRUNCATED_VALUE_SUFFIX.length + 10,
    );
    expect(String(redacted.corps)).toContain(TRUNCATED_VALUE_SUFFIX);
  });

  it('une pile d appels ordinaire survit entiere a la troncature', () => {
    const failure = new Error('echec');

    const redacted = redact_log_fields({ failure }) as { failure: { stack: string } };

    expect(redacted.failure.stack).not.toContain(TRUNCATED_VALUE_SUFFIX);
  });
});

// Certaines bibliotheques recopient la chaine de connexion dans le message.
// Le masquer entierement ferait perdre la seule information utile ; on masque
// donc ce qui, DANS le texte, ressemble a un secret.
describe('masquage des secrets contenus dans un texte d erreur', () => {
  it.each([
    [
      'une URL de connexion Postgres',
      'connect ECONNREFUSED postgres://portail:mot-de-passe-reel@postgres:5432/portail',
      'mot-de-passe-reel',
    ],
    ['un couple clef=valeur', 'echec avec password=mot-de-passe-reel', 'mot-de-passe-reel'],
    ['un couple clef: valeur', 'echec avec secret: mot-de-passe-reel', 'mot-de-passe-reel'],
    ['un jeton porteur', 'refus sur Bearer mot-de-passe-reel', 'mot-de-passe-reel'],
    [
      'un parametre de requete',
      'GET /callback?access_token=mot-de-passe-reel&x=1 a echoue',
      'mot-de-passe-reel',
    ],
  ])('%s est masquee dans le message', (_label: string, message: string, secret: string) => {
    const redacted = redact_log_fields({ failure: new Error(message) });

    expect(JSON.stringify(redacted)).not.toContain(secret);
  });

  it("le reste du message est conserve : masquer tout ferait perdre l'information utile", () => {
    const redacted = redact_log_fields({
      failure: new Error('connect ECONNREFUSED postgres://portail:secret-reel@postgres:5432/portail'),
    }) as { failure: { message: string } };

    expect(redacted.failure.message).toContain('ECONNREFUSED');
    expect(redacted.failure.message).toContain('postgres:5432');
    expect(redacted.failure.message).not.toContain('secret-reel');
  });

  it('la pile est masquee aussi : elle commence par le message', () => {
    const redacted = redact_log_fields({
      failure: new Error('echec password=secret-reel'),
    }) as { failure: { stack: string } };

    expect(redacted.failure.stack).not.toContain('secret-reel');
  });
});

// Revue offensive du 2026-09-08 : `format_log_entry` ne masquait QUE les champs.
// Le message, lui, etait recopie tel quel — or la passerelle BetterAuth y verse
// des chaines entierement choisies par l'appelant, comme « Invalid origin: ... ».
describe('le message est masque et borne comme les champs', () => {
  it("un secret contenu dans le message est masque : le message n'est pas plus sur qu'un champ", () => {
    const formatted: string = format_log_entry({
      level: 'error',
      message: 'echec de connexion a postgres://portail:mot-de-passe-secret@base:5432/portail',
      context: 'database',
      timestamp: '2026-09-08T12:00:00.000Z',
    });

    expect(formatted).not.toContain('mot-de-passe-secret');
  });

  it('un jeton porteur present dans le message est masque', () => {
    const formatted: string = format_log_entry({
      level: 'warn',
      message: 'en-tete rejete : Bearer aaaabbbbccccddddeeeeffff',
      context: 'lawyer_auth',
      timestamp: '2026-09-08T12:00:00.000Z',
    });

    expect(formatted).not.toContain('aaaabbbbccccddddeeeeffff');
  });

  it(
    "un message demesure est tronque : il est choisi par l'appelant, donc parfois par " +
      "l'attaquant, et une ligne de journal par requete de 8 Ko est un vecteur de saturation",
    () => {
      const formatted: string = format_log_entry({
        level: 'error',
        message: `Invalid origin: ${'x'.repeat(20_000)}`,
        context: 'lawyer_auth',
        timestamp: '2026-09-08T12:00:00.000Z',
      });

      expect(formatted.length).toBeLessThan(LOG_VALUE_LIMITS.max_string_length * 2);
      expect(formatted).toContain(TRUNCATED_VALUE_SUFFIX);
    },
  );

  it('un message ordinaire traverse sans etre altere', () => {
    const formatted: string = format_log_entry({
      level: 'info',
      message: 'application demarree',
      context: 'application',
      timestamp: '2026-09-08T12:00:00.000Z',
    });

    expect(JSON.parse(formatted).message).toBe('application demarree');
  });
});
