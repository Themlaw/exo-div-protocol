import type { ExpectedDocument } from '../../src/domain/expected_document';
import type { ExpectedDocumentRepository } from '../../src/deposit/expected_document_repository';

export class FakeExpectedDocumentRepository implements ExpectedDocumentRepository {
  private readonly documents = new Map<string, ExpectedDocument>();

  seed(...documents: readonly ExpectedDocument[]): void {
    for (const document of documents) {
      this.documents.set(document.id, document);
    }
  }

  async find_by_id(expected_document_id: string): Promise<ExpectedDocument | null> {
    return this.documents.get(expected_document_id) ?? null;
  }
}
