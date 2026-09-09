export interface AccessLinkDeliveryMessageInput {
  deposit_request_title: string;
  url: string;
  pin: string;
  expires_at: Date;
  max_pin_attempts: number;
}

// Le fuseau est celui du destinataire, pas celui du serveur : un lien qui
// expire a 00 h 30 le 17 heure de Paris serait annonce « le 16 » en UTC, et la
// date affichee ne serait pas celle qu'il vit.
const DELIVERY_MESSAGE_TIME_ZONE = 'Europe/Paris';

const EXPIRY_DATE_FORMAT = new Intl.DateTimeFormat('fr-FR', {
  dateStyle: 'long',
  timeZone: DELIVERY_MESSAGE_TIME_ZONE,
});

// Compose COTE SERVEUR, la ou le lien et le PIN existent en clair, une seule
// fois. Laisser le front assembler la phrase mettrait le gabarit hors de portee
// des tests du back, et deux clients pourraient en diverger.
//
// Texte brut, sans HTML ni echappement : il est colle tel quel dans un client
// mail quelconque, ou une entite `&amp;` arriverait sous les yeux du client.
export function compose_access_link_delivery_message(
  input: AccessLinkDeliveryMessageInput,
): string {
  return [
    'Bonjour,',
    '',
    `Vous pouvez deposer les documents demandes pour « ${input.deposit_request_title} »`,
    "a l'adresse suivante :",
    '',
    input.url,
    '',
    `Code d'acces : ${input.pin}`,
    '',
    // L'echeance ET le plafond d'essais sont annonces AVANT : un destinataire
    // qui apprend l'existence du plafond en se faisant bloquer l'apprend trop
    // tard, et c'est l'avocat qui paie la regeneration.
    `Ce lien est valable jusqu'au ${EXPIRY_DATE_FORMAT.format(input.expires_at)}.`,
    `Passe cette date, ou apres ${input.max_pin_attempts} codes errones,`,
    "il faudra m'en demander un nouveau.",
    '',
  ].join('\n');
}
