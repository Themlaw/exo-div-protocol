import { eq } from 'drizzle-orm';
import type { ApplicationDatabase } from '../db/database_connection';
import { expected_document } from '../db/schema/deposit_schema';
import type { ExpectedDocument } from '../domain/expected_document';

export const EXPECTED_DOCUMENT_REPOSITORY: unique symbol = Symbol('EXPECTED_DOCUMENT_REPOSITORY');

// Un depot a lui, minuscule, plutot qu'une methode de plus sur celui des
// demandes : le travailleur de scan n'a besoin QUE de l'emplacement, et lui
// donner acces a la lecture des demandes lui ouvrirait ce dont il n'a que faire.
export interface ExpectedDocumentRepository {
  find_by_id(expected_document_id: string): Promise<ExpectedDocument | null>;
}

export class DrizzleExpectedDocumentRepository implements ExpectedDocumentRepository {
  constructor(private readonly database: ApplicationDatabase) {}

  async find_by_id(expected_document_id: string): Promise<ExpectedDocument | null> {
    const rows = await this.database
      .select()
      .from(expected_document)
      .where(eq(expected_document.id, expected_document_id));

    const found = rows[0];
    if (found === undefined) {
      return null;
    }

    return {
      id: found.id,
      deposit_request_id: found.deposit_request_id,
      label: found.label,
      position: found.position,
      allowed_mime_types: found.allowed_mime_types,
      max_size_bytes: found.max_size_bytes,
    };
  }
}
