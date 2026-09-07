import {
  compute_login_backoff_delay_seconds,
  LOGIN_BACKOFF_BOUNDS,
} from '../../../src/auth/login_throttling';

describe('compute_login_backoff_delay_seconds', () => {
  it("en dessous de LOGIN_BACKOFF_BOUNDS.attempts_before_backoff, le delai est nul : un avocat qui se trompe une fois ne doit pas etre puni", () => {
    for (
      let consecutive_failed_attempts = 0;
      consecutive_failed_attempts < LOGIN_BACKOFF_BOUNDS.attempts_before_backoff;
      consecutive_failed_attempts += 1
    ) {
      expect(
        compute_login_backoff_delay_seconds(consecutive_failed_attempts),
      ).toBe(0);
    }
  });

  it('au-dela du seuil, le delai croit strictement avec le nombre de tentatives', () => {
    const delays: number[] = [];
    for (
      let consecutive_failed_attempts = LOGIN_BACKOFF_BOUNDS.attempts_before_backoff;
      consecutive_failed_attempts < LOGIN_BACKOFF_BOUNDS.attempts_before_backoff + 5;
      consecutive_failed_attempts += 1
    ) {
      delays.push(compute_login_backoff_delay_seconds(consecutive_failed_attempts));
    }

    for (let index = 1; index < delays.length; index += 1) {
      expect(delays[index]).toBeGreaterThan(delays[index - 1]);
    }
  });

  it('[21] on ralentit, on ne ferme jamais : le delai est plafonne a LOGIN_BACKOFF_BOUNDS.max_delay_seconds et ne le depasse jamais meme pour un tres grand nombre de tentatives', () => {
    const delay = compute_login_backoff_delay_seconds(1_000_000);

    expect(delay).toBeLessThanOrEqual(LOGIN_BACKOFF_BOUNDS.max_delay_seconds);
  });

  it("le delai n'est jamais negatif, et zero tentative donne zero delai", () => {
    expect(compute_login_backoff_delay_seconds(0)).toBe(0);
    expect(compute_login_backoff_delay_seconds(0)).toBeGreaterThanOrEqual(0);
    expect(
      compute_login_backoff_delay_seconds(LOGIN_BACKOFF_BOUNDS.attempts_before_backoff),
    ).toBeGreaterThanOrEqual(0);
  });
});
