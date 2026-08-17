import * as fs from 'fs';
import * as path from 'path';
import { defaultConfig } from '../config';

describe('syncOption schema defaults', () => {
  const schemaPath = path.resolve(__dirname, '../../../schema/definitions.json');
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  const properties = schema.option.properties.syncOption.properties;

  test.each(['delete', 'skipCreate', 'ignoreExisting', 'update'])(
    '%s is off by default in both the schema and runtime config',
    key => {
      expect(properties[key].default).toBe(false);
      // Runtime leaves the object unset; each consumer treats an unset flag as
      // false. Keeping it absent avoids accidentally introducing a merge
      // default that would override a profile value.
      expect((defaultConfig as Record<string, unknown>).syncOption).toBeUndefined();
    }
  );
});
