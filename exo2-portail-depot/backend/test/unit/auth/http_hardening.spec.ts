import { apply_http_hardening } from '../../../src/shared/http_hardening';

interface FakeExpressApplication {
  disabled: readonly string[];
  disable(setting: string): void;
}

function build_fake_express_application(): FakeExpressApplication {
  const disabled: string[] = [];
  return {
    disabled,
    disable(setting: string): void {
      disabled.push(setting);
    },
  };
}

// Revue offensive du 2026-09-08 : toutes les reponses portaient
// `X-Powered-By: Express`. Divulgation gratuite de la pile, qui oriente le choix
// des exploits avant meme la premiere tentative.
describe('apply_http_hardening', () => {
  it("l'en-tete qui annonce la pile est desactive", () => {
    const application = build_fake_express_application();

    apply_http_hardening(application as never);

    expect(application.disabled).toContain('x-powered-by');
  });
});
