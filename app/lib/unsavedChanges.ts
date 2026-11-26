/**
 * Unsaved-changes rules for the embedded admin's forms (Built for Shopify 4.1.5).
 *
 * A form with editable fields shows Shopify's contextual save bar while its values
 * differ from the last SAVED values, and at no other time:
 *  - typing a value back to what is saved hides the bar (nothing to save);
 *  - a successful save makes the submitted values the saved ones (bar hides);
 *  - a failed save keeps the edit AND the bar (nothing is lost, nothing looks saved);
 *  - Discard puts the saved values back and clears the errors.
 * Pure, so the rules are unit-tested without a browser (test/unsavedChanges.test.ts).
 */
export type FormValues = Record<string, string>;

/** True when any field differs from its saved value. Whitespace counts: the merchant typed it. */
export function isDirty<T extends FormValues>(current: T, saved: T): boolean {
  for (const key of Object.keys(saved)) if (current[key] !== saved[key]) return true;
  return false;
}

export interface FormState<T extends FormValues> {
  /** What the fields show now. */
  values: T;
  /** The last values known to be saved. */
  saved: T;
  /** Inline message per field; only ever set by a save attempt (never before the merchant acts). */
  errors: Partial<Record<keyof T, string>>;
  /** A failure that belongs to no single field (shown as a banner that stays until the next attempt). */
  formError: string | null;
}

export type FormEvent<T extends FormValues> =
  | { type: "edit"; field: keyof T; value: string }
  | { type: "invalid"; errors: Partial<Record<keyof T, string>> }
  | { type: "submit" }
  | { type: "saved"; values: T }
  | { type: "failed"; errors?: Partial<Record<keyof T, string>>; formError?: string | null }
  | { type: "discard" };

export function initialFormState<T extends FormValues>(saved: T): FormState<T> {
  return { values: saved, saved, errors: {}, formError: null };
}

export function formReducer<T extends FormValues>(state: FormState<T>, event: FormEvent<T>): FormState<T> {
  switch (event.type) {
    case "edit": {
      // Editing a field clears ITS error only; the other field's message stays until fixed.
      const errors = { ...state.errors };
      delete errors[event.field];
      return { ...state, values: { ...state.values, [event.field]: event.value }, errors };
    }
    case "invalid":
      return { ...state, errors: event.errors, formError: null };
    case "submit":
      return { ...state, errors: {}, formError: null };
    case "saved":
      return { values: event.values, saved: event.values, errors: {}, formError: null };
    case "failed": {
      const errors = event.errors ?? {};
      // A field message is enough on its own; the banner is for failures no field explains.
      return { ...state, errors, formError: Object.keys(errors).length ? null : (event.formError ?? null) };
    }
    case "discard":
      return initialFormState(state.saved);
  }
}
