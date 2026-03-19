const FIREBASE_WEB_API_KEY = 'AIzaSyA17Uwy37irVEQSwz6PIyX3wnkHrDBeleA';
const FIREBASE_PROJECT_ID = 'sbs-diet-app';
const FIRESTORE_BASE_URL = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;
const IOS_BUNDLE_ID = 'com.sbs.diet';
const TOKEN_REFRESH_MARGIN_MS = 60_000;

interface FirebaseSession {
  idToken: string;
  refreshToken: string;
  expiresAtMs: number;
  userId: string;
}

interface FirestoreDocumentResponse {
  fields?: Record<string, unknown>;
}

interface FirebaseSignInResponse {
  idToken?: string;
  refreshToken?: string;
  expiresIn?: string;
  localId?: string;
}

interface FirebaseRefreshResponse {
  id_token?: string;
  refresh_token?: string;
  expires_in?: string;
}

export function parseFirestoreValue(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  const typedValue = value as Record<string, unknown>;
  if ('stringValue' in typedValue) {
    return typedValue.stringValue ?? null;
  }
  if ('integerValue' in typedValue) {
    return parseNumberLike(typedValue.integerValue) ?? typedValue.integerValue ?? null;
  }
  if ('doubleValue' in typedValue) {
    return parseNumberLike(typedValue.doubleValue) ?? typedValue.doubleValue ?? null;
  }
  if ('booleanValue' in typedValue) {
    return Boolean(typedValue.booleanValue);
  }
  if ('nullValue' in typedValue) {
    return null;
  }
  if ('timestampValue' in typedValue) {
    return typedValue.timestampValue ?? null;
  }
  if ('referenceValue' in typedValue) {
    return typedValue.referenceValue ?? null;
  }
  if ('geoPointValue' in typedValue) {
    return typedValue.geoPointValue ?? null;
  }
  if ('bytesValue' in typedValue) {
    return typedValue.bytesValue ?? null;
  }
  if ('mapValue' in typedValue) {
    const mapValue = typedValue.mapValue;
    if (mapValue && typeof mapValue === 'object' && !Array.isArray(mapValue)) {
      return parseFirestoreFields((mapValue as { fields?: unknown }).fields);
    }
    return {};
  }
  if ('arrayValue' in typedValue) {
    const arrayValue = typedValue.arrayValue;
    if (!arrayValue || typeof arrayValue !== 'object' || Array.isArray(arrayValue)) {
      return [];
    }
    const values = (arrayValue as { values?: unknown }).values;
    if (!Array.isArray(values)) {
      return [];
    }
    return values.map(parseFirestoreValue);
  }
  return typedValue;
}

export function parseFirestoreFields(fields: unknown): Record<string, unknown> {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    return {};
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    result[key] = parseFirestoreValue(value);
  }
  return result;
}

export class MacroFactorApiClient {
  private constructor(private readonly session: FirebaseSession) {}

  static async login(email: string, password: string): Promise<MacroFactorApiClient> {
    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_WEB_API_KEY}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Ios-Bundle-Identifier': IOS_BUNDLE_ID,
        },
        body: JSON.stringify({
          email,
          password,
          returnSecureToken: true,
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`MacroFactor sign-in failed: ${await formatError(response)}`);
    }

    const data = (await response.json()) as FirebaseSignInResponse;
    if (!data.idToken || !data.refreshToken || !data.expiresIn || !data.localId) {
      throw new Error('MacroFactor sign-in response was missing required auth fields.');
    }

    return new MacroFactorApiClient({
      idToken: data.idToken,
      refreshToken: data.refreshToken,
      expiresAtMs: Date.now() + Number(data.expiresIn) * 1000,
      userId: data.localId,
    });
  }

  async getFoodLogDocument(date: string): Promise<Record<string, unknown> | null> {
    const token = await this.getIdToken();
    const response = await fetch(`${FIRESTORE_BASE_URL}/users/${this.session.userId}/food/${date}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`MacroFactor food log request failed for ${date}: ${await formatError(response)}`);
    }

    const document = (await response.json()) as FirestoreDocumentResponse;
    return parseFirestoreFields(document.fields);
  }

  async getCustomFoodDocument(id: string): Promise<Record<string, unknown> | null> {
    const token = await this.getIdToken();
    const response = await fetch(`${FIRESTORE_BASE_URL}/users/${this.session.userId}/customFoods/${id}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`MacroFactor custom food request failed for ${id}: ${await formatError(response)}`);
    }

    const document = (await response.json()) as FirestoreDocumentResponse;
    return parseFirestoreFields(document.fields);
  }

  async getProgramDocument(year: number | string): Promise<Record<string, unknown> | null> {
    const token = await this.getIdToken();
    const response = await fetch(`${FIRESTORE_BASE_URL}/users/${this.session.userId}/program/${year}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`MacroFactor program request failed for ${year}: ${await formatError(response)}`);
    }

    const document = (await response.json()) as FirestoreDocumentResponse;
    return parseFirestoreFields(document.fields);
  }

  private async getIdToken(): Promise<string> {
    if (this.session.expiresAtMs - TOKEN_REFRESH_MARGIN_MS > Date.now()) {
      return this.session.idToken;
    }

    const response = await fetch(`https://securetoken.googleapis.com/v1/token?key=${FIREBASE_WEB_API_KEY}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Ios-Bundle-Identifier': IOS_BUNDLE_ID,
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.session.refreshToken,
      }).toString(),
    });

    if (!response.ok) {
      throw new Error(`MacroFactor token refresh failed: ${await formatError(response)}`);
    }

    const data = (await response.json()) as FirebaseRefreshResponse;
    if (!data.id_token || !data.refresh_token || !data.expires_in) {
      throw new Error('MacroFactor token refresh response was missing required auth fields.');
    }

    this.session.idToken = data.id_token;
    this.session.refreshToken = data.refresh_token;
    this.session.expiresAtMs = Date.now() + Number(data.expires_in) * 1000;
    return this.session.idToken;
  }
}

function parseNumberLike(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

async function formatError(response: Response): Promise<string> {
  const body = await response.text();
  const snippet = body.trim().slice(0, 500);
  return `${response.status} ${response.statusText}${snippet ? `: ${snippet}` : ''}`;
}
