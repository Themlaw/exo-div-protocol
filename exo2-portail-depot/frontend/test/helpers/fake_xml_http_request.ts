import { vi } from 'vitest';

export interface CapturedUpload {
  readonly method: string;
  readonly url: string;
  readonly form: FormData;
  emit_progress(transferred_bytes: number, total_bytes: number): void;
  finish(status: number): void;
}

// Un faux `XMLHttpRequest` plutot qu'un vrai serveur : jsdom n'envoie rien, et
// c'est precisement la progression — que `fetch` ne sait pas rapporter — qu'on
// veut observer.
export function stub_xml_http_request(): CapturedUpload[] {
  const captured: CapturedUpload[] = [];

  class FakeXMLHttpRequest {
    #listeners = new Map<string, ((event: unknown) => void)[]>();
    #upload_listeners = new Map<string, ((event: unknown) => void)[]>();
    status = 0;

    readonly upload = {
      addEventListener: (name: string, listener: (event: unknown) => void): void => {
        this.#upload_listeners.set(name, [
          ...(this.#upload_listeners.get(name) ?? []),
          listener,
        ]);
      },
    };

    addEventListener(name: string, listener: (event: unknown) => void): void {
      this.#listeners.set(name, [...(this.#listeners.get(name) ?? []), listener]);
    }

    open(method: string, url: string): void {
      this.method = method;
      this.url = url;
    }

    send(form: FormData): void {
      captured.push({
        method: this.method,
        url: this.url,
        form,
        emit_progress: (transferred_bytes: number, total_bytes: number): void => {
          for (const listener of this.#upload_listeners.get('progress') ?? []) {
            listener({ loaded: transferred_bytes, total: total_bytes, lengthComputable: true });
          }
        },
        finish: (status: number): void => {
          this.status = status;
          for (const listener of this.#listeners.get(status === 0 ? 'error' : 'load') ?? []) {
            listener({});
          }
        },
      });
    }

    private method = '';
    private url = '';
  }

  vi.stubGlobal('XMLHttpRequest', FakeXMLHttpRequest);

  return captured;
}
