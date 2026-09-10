import {
  matches_internal_shared_secret,
  read_presented_shared_secret,
} from '../../../src/auth/internal_shared_secret';

const EXPECTED_SECRET = 'un-secret-partage-suffisamment-long-pour-ressembler-au-vrai-0123456789';

describe('Secret partage des surfaces internes', () => {
  describe('Lecture du secret presente', () => {
    it("lit l'en-tete brut, tel que MinIO l'envoie", () => {
      expect(read_presented_shared_secret(EXPECTED_SECRET)).toBe(EXPECTED_SECRET);
    });

    // Prometheus ne PEUT PAS envoyer un `Authorization` brut : sa configuration
    // impose un schema, et elle refuse de surcharger cet en-tete autrement. Les
    // deux formes sont donc acceptees, et l'emetteur qu'on ne peut pas
    // configurer — MinIO — garde la sienne.
    it("accepte la forme `Bearer <secret>`, celle que Prometheus sait envoyer", () => {
      expect(read_presented_shared_secret(`Bearer ${EXPECTED_SECRET}`)).toBe(EXPECTED_SECRET);
    });

    it("n'accepte pas un autre schema que Bearer", () => {
      expect(read_presented_shared_secret(`Basic ${EXPECTED_SECRET}`)).toBe(
        `Basic ${EXPECTED_SECRET}`,
      );
    });

    it("rend null quand l'en-tete est absent", () => {
      expect(read_presented_shared_secret(undefined)).toBeNull();
    });

    // Node rend un tableau quand l'en-tete arrive plusieurs fois. En choisir un
    // laisserait un appelant en poser deux, dont un valide, pour brouiller la
    // lecture des journaux.
    it("rend null quand l'en-tete arrive plusieurs fois", () => {
      expect(read_presented_shared_secret([EXPECTED_SECRET, EXPECTED_SECRET])).toBeNull();
    });
  });

  describe('Comparaison', () => {
    it('reconnait le secret attendu', () => {
      expect(matches_internal_shared_secret(EXPECTED_SECRET, EXPECTED_SECRET)).toBe(true);
    });

    it('refuse un secret different de meme longueur', () => {
      const wrong_secret: string = `${'x'.repeat(EXPECTED_SECRET.length - 1)}y`;

      expect(matches_internal_shared_secret(wrong_secret, EXPECTED_SECRET)).toBe(false);
    });

    it('refuse un secret de longueur differente sans lever', () => {
      expect(matches_internal_shared_secret('court', EXPECTED_SECRET)).toBe(false);
      expect(matches_internal_shared_secret('x'.repeat(5000), EXPECTED_SECRET)).toBe(false);
    });

    // L'absence est comparee comme une chaine vide plutot que court-circuitee :
    // sinon l'absence de secret repondrait plus vite que le mauvais secret.
    it('refuse une absence sans lever', () => {
      expect(matches_internal_shared_secret(undefined, EXPECTED_SECRET)).toBe(false);
    });
  });
});
