import { primary_button_recipe } from '../../src/theme/div_recipes';
import { DIV_BASE_COLORS } from '../../src/theme/div_charter';

// L'inversion au survol est un critere d'evaluation explicite de la charte.
//
// LIMITE ASSUMEE : jsdom n'applique aucun pseudo-etat, donc aucun test de
// composant ne peut observer la couleur REELLEMENT peinte au survol. Ces
// assertions portent sur la RECETTE — ce que le theme declare — et le rendu
// peint est prouve par Playwright au bloc 4. C'est precisement pour cela que
// l'inversion figure dans les quatre scenarios de navigateur.
describe('Bouton primaire — la signature d interaction', () => {
  const base = primary_button_recipe.base as Record<string, unknown>;

  it('au repos : fond primary, texte blanc, poids des CTA, radius plein', () => {
    expect(base['bg']).toBe('primary');
    expect(base['color']).toBe('surface');
    expect(base['fontWeight']).toBe('heading');
    expect(base['borderRadius']).toBe('full');
  });

  const hovering_pointer = base['@media (hover: hover)'] as Record<string, unknown>;

  it('au repos : 24px de padding horizontal et 14px de vertical', () => {
    expect(base['paddingInline']).toBe('24px');
    expect(base['paddingBlock']).toBe('14px');
  });

  // Les trois proprietes ensemble, jamais l'une sans les autres : un fond
  // inverse sans le contour donnerait un bouton qui semble disparaitre.
  it('au survol : il s inverse — fond accent, texte primary, contour inset 1px primary', () => {
    const hover = hovering_pointer['_hover'] as Record<string, unknown>;

    expect(hover['bg']).toBe('accent.surface');
    expect(hover['color']).toBe('primary');
    expect(hover['boxShadow']).toBe(`inset 0 0 0 1px ${DIV_BASE_COLORS.primary}`);
  });

  // Et il ne s'inverse QUE la : sur tactile, `:hover` reste accroche apres le
  // tap, et le bouton primaire restait inverse — donc indiscernable d'un bouton
  // secondaire — sur l'ecran ou l'on venait d'appuyer.
  it('le survol est reserve aux pointeurs qui survolent reellement', () => {
    expect(base['_hover']).toBeUndefined();
    expect(hovering_pointer).toBeDefined();
  });

  // Un bouton desactive qui s'inverse au survol promet une action qui n'aura
  // pas lieu.
  it('desactive, il ne s inverse pas', () => {
    const disabled = base['_disabled'] as Record<string, unknown>;

    expect(disabled['bg']).toBe('gray.light');
    expect(disabled['color']).toBe('gray.default');
    expect(disabled['cursor']).toBe('not-allowed');
    expect(disabled['boxShadow']).toBe('none');
  });
});
