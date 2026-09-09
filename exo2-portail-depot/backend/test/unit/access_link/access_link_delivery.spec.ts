import { randomBytes } from 'node:crypto';
import { generate_client_pin } from '../../../src/access_link/client_pin_generator';
import { compose_access_link_delivery_message } from '../../../src/access_link/access_link_delivery_message';
import type { RandomSource } from '../../../src/domain/presigned_upload';

const REAL_RANDOM_SOURCE: RandomSource = { bytes: (length: number): Buffer => randomBytes(length) };

describe('generate_client_pin', () => {
  it('rend exactement la longueur demandee, et rien que des chiffres', () => {
    for (const pin_length of [4, 6, 12]) {
      const pin: string = generate_client_pin(REAL_RANDOM_SOURCE, pin_length);

      expect(pin).toHaveLength(pin_length);
      expect(pin).toMatch(/^\d+$/);
    }
  });

  // Le rejet est la raison d'etre de cette fonction : `octet % 10` sortirait les
  // chiffres 0 a 5 plus souvent que 6 a 9, et sur six chiffres cela retire de
  // l'entropie la ou il y en a deja peu.
  it('rejette les octets qui biaiseraient le tirage plutot que de les replier sur l alphabet', () => {
    const rejected_then_accepted: RandomSource = {
      // 250 est le premier octet de la zone biaisee pour dix chiffres :
      // 256 = 25 x 10 + 6, donc 250 a 255 replies donneraient 0 a 5 en prime.
      bytes: (): Buffer => Buffer.from([250, 7, 3, 1, 9]),
    };

    // Le premier octet, hors zone non biaisee, est ecarte : le PIN commence
    // donc au suivant.
    expect(generate_client_pin(rejected_then_accepted, 4)).toBe('7319');
  });

  it('retire des octets quand la reserve est epuisee, plutot que de rendre un PIN trop court', () => {
    let draw_count = 0;
    const two_bytes_at_a_time: RandomSource = {
      bytes: (): Buffer => {
        draw_count += 1;
        return Buffer.from([1, 2]);
      },
    };

    expect(generate_client_pin(two_bytes_at_a_time, 6)).toHaveLength(6);
    expect(draw_count).toBeGreaterThan(1);
  });

  it('sur mille tirages, ne produit jamais deux fois le meme PIN a douze chiffres', () => {
    const pins = new Set<string>();
    for (let draw = 0; draw < 1000; draw += 1) {
      pins.add(generate_client_pin(REAL_RANDOM_SOURCE, 12));
    }

    expect(pins.size).toBe(1000);
  });
});

describe('compose_access_link_delivery_message', () => {
  const DELIVERY = {
    deposit_request_title: 'Dossier de succession',
    url: 'https://portail.fr/depot/aZ09aZ09aZ09aZ09aZ09aZ09aZ09aZ09',
    pin: '482173',
    expires_at: new Date('2026-09-16T21:59:00.000Z'),
    max_pin_attempts: 10,
  } as const;

  it('porte l adresse complete, le code et le titre de la demande', () => {
    const message: string = compose_access_link_delivery_message(DELIVERY);

    expect(message).toContain(DELIVERY.url);
    expect(message).toContain(DELIVERY.pin);
    expect(message).toContain(DELIVERY.deposit_request_title);
  });

  // L'echeance est lue a Paris et non en UTC : un lien qui expire le 16 a
  // 23 h 59 heure francaise serait annonce pour le 16 en ete, mais un lien qui
  // expire a 00 h 30 le 17 serait annonce pour le 16 en UTC — la date affichee
  // ne serait pas celle que vit le destinataire.
  it("annonce l'echeance en date francaise, sur le fuseau de Paris", () => {
    const message: string = compose_access_link_delivery_message(DELIVERY);

    expect(message).toContain('16 septembre 2026');
  });

  it('dit combien de codes errones font tomber le lien : le destinataire doit savoir avant, pas apres', () => {
    expect(compose_access_link_delivery_message(DELIVERY)).toContain('10');
  });

  // Le message est colle dans un client mail quelconque : une balise ou une
  // entite HTML y arriverait telle quelle sous les yeux du client.
  it('reste en texte brut, sans balise ni entite HTML', () => {
    const message: string = compose_access_link_delivery_message({
      ...DELIVERY,
      deposit_request_title: 'Succession <b>Durand</b> & fils',
    });

    expect(message).not.toContain('&amp;');
    expect(message).toContain('Succession <b>Durand</b> & fils');
  });
});
