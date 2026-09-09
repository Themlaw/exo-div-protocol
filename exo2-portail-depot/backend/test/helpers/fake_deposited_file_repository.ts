import type { DepositedFile } from '../../src/domain/deposited_file';
import { does_deposited_file_occupy_expected_document } from '../../src/domain/deposited_file';
import type {
  DepositedFileRepository,
  NewDepositedFile,
} from '../../src/deposited_file/deposited_file_repository';
import { ExpectedDocumentAlreadyOccupiedError } from '../../src/deposited_file/deposited_file_repository';

// Rejoue l'index unique partiel de la base : sans lui, les tests de course
// passeraient sur un double qui accepte deux occupants la ou Postgres refuse,
// et ne prouveraient rien.
export class FakeDepositedFileRepository implements DepositedFileRepository {
  readonly files = new Map<string, DepositedFile>();
  private next_identifier = 1;

  seed(...files: readonly DepositedFile[]): void {
    for (const file of files) {
      this.files.set(file.id, file);
    }
  }

  async find_for_access_link(
    deposited_file_id: string,
    access_link_id: string,
  ): Promise<DepositedFile | null> {
    const file: DepositedFile | undefined = this.files.get(deposited_file_id);
    return file !== undefined && file.access_link_id === access_link_id ? file : null;
  }

  async find_by_id(deposited_file_id: string): Promise<DepositedFile | null> {
    return this.files.get(deposited_file_id) ?? null;
  }

  async find_by_object_key(object_key: string): Promise<DepositedFile | null> {
    return [...this.files.values()].find((file) => file.object_key === object_key) ?? null;
  }

  async find_occupant_of_expected_document(
    expected_document_id: string,
  ): Promise<DepositedFile | null> {
    return (
      [...this.files.values()].find(
        (file) =>
          file.expected_document_id === expected_document_id &&
          does_deposited_file_occupy_expected_document(file),
      ) ?? null
    );
  }

  async list_for_deposit_request(): Promise<DepositedFile[]> {
    return [...this.files.values()];
  }

  async count_occupied_expected_documents(): Promise<Map<string, number>> {
    return new Map();
  }

  async list_upload_reservations_created_before(instant: Date): Promise<DepositedFile[]> {
    return [...this.files.values()].filter(
      (file) => file.status === 'pending_upload' && file.created_at < instant,
    );
  }

  async list_scans_pending_since_before(instant: Date): Promise<DepositedFile[]> {
    return [...this.files.values()].filter(
      (file) =>
        file.status === 'pending_scan' && file.uploaded_at !== null && file.uploaded_at < instant,
    );
  }

  async reserve_upload_slot(file: NewDepositedFile): Promise<DepositedFile> {
    const reserved: DepositedFile = { ...file, id: `file-${this.next_identifier++}` };
    this.refuse_second_occupant(reserved);
    this.files.set(reserved.id, reserved);
    return reserved;
  }

  async save_state(file: DepositedFile): Promise<void> {
    this.refuse_second_occupant(file);
    this.files.set(file.id, file);
  }

  async delete_file(deposited_file_id: string): Promise<void> {
    this.files.delete(deposited_file_id);
  }

  private refuse_second_occupant(file: DepositedFile): void {
    if (!does_deposited_file_occupy_expected_document(file)) {
      return;
    }

    const occupant: DepositedFile | undefined = [...this.files.values()].find(
      (candidate) =>
        candidate.id !== file.id &&
        candidate.expected_document_id === file.expected_document_id &&
        does_deposited_file_occupy_expected_document(candidate),
    );

    if (occupant !== undefined) {
      throw new ExpectedDocumentAlreadyOccupiedError(file.expected_document_id);
    }
  }
}
