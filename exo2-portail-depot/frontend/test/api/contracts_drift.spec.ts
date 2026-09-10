import type {
  DepositRequestOverview as BackendDepositRequestOverview,
  DepositRequestDetail as BackendDepositRequestDetail,
} from '../../../backend/src/deposit/deposit_request_repository';
import type {
  LawyerDepositedFileView as BackendLawyerDepositedFileView,
  LawyerExpectedDocumentView as BackendLawyerExpectedDocumentView,
} from '../../../backend/src/deposit/lawyer_deposit_views';
import type {
  DepositRequestActivitySummary as BackendActivitySummary,
  LawyerActivityEventView as BackendLawyerActivityEventView,
  ActivityActor as BackendActivityActor,
  ActivityEventType as BackendActivityEventType,
} from '../../../backend/src/domain/activity_event';
import type { AccessLinkDelivery as BackendAccessLinkDelivery } from '../../../backend/src/access_link/access_link_issuer';
import type { SecurityPolicy as BackendSecurityPolicy } from '../../../backend/src/domain/security_policy';
import type { DepositRequestStatus as BackendDepositRequestStatus } from '../../../backend/src/domain/deposit_request_status';
import type {
  DepositedFileStatus as BackendDepositedFileStatus,
} from '../../../backend/src/domain/deposited_file';
import type { PublicAccessLinkState as BackendPublicAccessLinkState } from '../../../backend/src/domain/access_link';
import type {
  ClientDepositBoardView as BackendClientDepositBoardView,
  ClientDepositedFileView as BackendClientDepositedFileView,
  ClientExpectedDocumentView as BackendClientExpectedDocumentView,
  ClientUploadTicketView as BackendClientUploadTicketView,
  PublicAccessLinkView as BackendPublicAccessLinkView,
} from '../../../backend/src/deposit_session/client_deposit_views';
import type { PresignedDownloadTicket as BackendPresignedDownloadTicket } from '../../../backend/src/object_storage/object_storage';

import type * as Front from '../../src/api/contracts';

// Ce fichier ne prouve rien A L'EXECUTION : il echoue au `typecheck`, ce qui est
// le seul moment ou l'on peut encore reagir. Un champ renomme, retire, ajoute ou
// retype cote backend casse le `npm run build` du front, et non un ecran en
// production.
//
// La comparaison passe par `Serialized` parce que les deux formes ne sont PAS
// identiques : une `Date` traverse JSON en chaine ISO. C'est precisement la
// difference qu'on veut voir declaree une fois plutot que devinee par ecran.
//
// Le tableau mutable est traite AVANT le tableau en lecture seule : les prendre
// dans l'autre ordre rendrait tout tableau `readonly`, et le test echouerait
// alors sur une difference que la serialisation JSON n'introduit pas.
type Serialized<T> = T extends Date
  ? string
  : T extends (infer MutableItem)[]
    ? Serialized<MutableItem>[]
    : T extends readonly (infer Item)[]
      ? readonly Serialized<Item>[]
      : T extends object
        ? { [Key in keyof T]: Serialized<T[Key]> }
        : T;

// Les deux sens, jamais un seul : `A extends B` seul laisserait passer un champ
// ajoute cote backend que le front ignorerait en silence.
type AssertMutuallyAssignable<
  Left extends Right,
  Right extends Left2,
  Left2 = Left,
> = [Left, Right, Left2];

type Checks = [
  AssertMutuallyAssignable<Front.DepositRequestStatus, BackendDepositRequestStatus>,
  AssertMutuallyAssignable<Front.DepositedFileStatus, BackendDepositedFileStatus>,
  AssertMutuallyAssignable<Front.PublicAccessLinkState, BackendPublicAccessLinkState>,
  AssertMutuallyAssignable<Front.ActivityEventType, BackendActivityEventType>,
  AssertMutuallyAssignable<Front.ActivityActor, BackendActivityActor>,
  AssertMutuallyAssignable<Front.SecurityPolicy, Serialized<BackendSecurityPolicy>>,
  AssertMutuallyAssignable<
    Front.DepositRequestActivitySummary,
    Serialized<BackendActivitySummary>
  >,
  AssertMutuallyAssignable<
    Front.DepositRequestOverview,
    Serialized<BackendDepositRequestOverview>
  >,
  AssertMutuallyAssignable<Front.DepositRequestDetail, Serialized<BackendDepositRequestDetail>>,
  AssertMutuallyAssignable<
    Front.LawyerExpectedDocumentView,
    Serialized<BackendLawyerExpectedDocumentView>
  >,
  AssertMutuallyAssignable<
    Front.LawyerDepositedFileView,
    Serialized<BackendLawyerDepositedFileView>
  >,
  AssertMutuallyAssignable<
    Front.LawyerActivityEventView,
    Serialized<BackendLawyerActivityEventView>
  >,
  AssertMutuallyAssignable<Front.AccessLinkDelivery, Serialized<BackendAccessLinkDelivery>>,
  AssertMutuallyAssignable<
    Front.PresignedDownloadTicket,
    Serialized<BackendPresignedDownloadTicket>
  >,
  AssertMutuallyAssignable<Front.PublicAccessLinkView, Serialized<BackendPublicAccessLinkView>>,
  AssertMutuallyAssignable<
    Front.ClientDepositBoardView,
    Serialized<BackendClientDepositBoardView>
  >,
  AssertMutuallyAssignable<
    Front.ClientExpectedDocumentView,
    Serialized<BackendClientExpectedDocumentView>
  >,
  AssertMutuallyAssignable<
    Front.ClientDepositedFileView,
    Serialized<BackendClientDepositedFileView>
  >,
  AssertMutuallyAssignable<
    Front.ClientUploadTicketView,
    Serialized<BackendClientUploadTicketView>
  >,
];

describe('Contrats d API', () => {
  // Le corps est vide, et c'est normal : la preuve est dans les types ci-dessus,
  // et elle est rendue par le compilateur. Ce test existe pour que la suite
  // signale explicitement que le fichier a bien ete compile — un fichier de
  // types pur pourrait etre supprime sans que rien ne le remarque.
  it('ne derivent pas des types rendus par le backend', () => {
    const checked: Checks | undefined = undefined;

    expect(checked).toBeUndefined();
  });
});
