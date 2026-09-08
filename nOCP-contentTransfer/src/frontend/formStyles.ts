// Verbatim port of the source app's src/cms-ui-extensions/content-transfer/
// formStyles.ts — plain native inputs/selects rather than guessing at
// unconfirmed @optiaxiom/react form-input component APIs.
import type {CSSProperties} from 'react';

export const fieldLabelStyle: CSSProperties = {display: 'block', marginBottom: 4};

export const inputStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '6px 8px',
  fontSize: 13,
  borderRadius: 4,
  border: '1px solid var(--ax-border-default, #ccc)',
};
