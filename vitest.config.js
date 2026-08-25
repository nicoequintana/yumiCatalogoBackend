import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Un `test.only` commiteado angosta la suite en silencio y no hay CI que
    // lo atrape: acá la corrida falla fuerte si queda uno. Para enfocar un
    // test durante el desarrollo, usar `npx vitest run <archivo>` o `-t`.
    forbidOnly: true,
  },
});
