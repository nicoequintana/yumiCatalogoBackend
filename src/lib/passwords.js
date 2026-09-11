import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { PASSWORDS_COMUNES } from "./passwordsComunes.js";

/**
 * La única casa de bcrypt. `auth.controller.js` y `usuarios.controller.js`
 * tenían cada uno su `SALT_ROUNDS = 10`; ahora todo hash del sistema sale de
 * acá y el costo se cambia en un solo lugar.
 *
 * COSTO 11 y no 12, con número medido: `bcryptjs` es JS puro (sin binding
 * nativo) y en esta máquina costo 12 tarda 246 ms por hash contra 71 ms de
 * costo 10. Un vCPU compartido de EasyPanel es 2-4x más lento. Cinco endpoints
 * públicos hashean; a 12, cien IPs residenciales dentro de todos los límites
 * saturan un núcleo. Sumar `bcrypt` nativo mete toolchain de compilación en
 * `node:22-alpine`. Ver Amenaza 9 de la spec. Se vuelve a medir en el
 * contenedor real antes de subirlo.
 *
 * Esta función no admite: la admisión es de `colaBcrypt.js`, y se decide en el
 * handler ANTES de tocar la base — si viviera acá, se decidiría después del
 * `findUnique` y con la cola saturada "cuenta existente" daría 503 y
 * "inexistente" 401.
 */
export const COSTO_BCRYPT = 11;

export const LARGO_MIN_PASSWORD = 8;
/** bcrypt trunca a 72 bytes; más allá, un body grande solo cuesta CPU. */
export const LARGO_MAX_PASSWORD = 128;

/**
 * Hash real de un valor aleatorio, con el costo vigente, para comparar contra
 * él cuando la cuenta no existe: así el login tarda lo mismo exista o no.
 *
 * Ventana transitoria y auto-sanable: los admins existentes tienen hashes al
 * costo VIEJO (10) hasta que cada uno entra una vez y `rehashSiHaceFalta`
 * (auth.controller.js) los sube al vigente (11). Hasta entonces, un login con
 * un email INEXISTENTE compara contra este señuelo a costo 11 — casi el
 * doble de CPU que comparar contra el hash real (costo 10) de un admin que
 * todavía no re-logueó. Se corrige solo con cada login real; no hace falta
 * ninguna acción.
 */
export const HASH_SENUELO = bcrypt.hashSync(randomBytes(32).toString("hex"), COSTO_BCRYPT);

export function hashearPassword(password) {
  return bcrypt.hash(password, COSTO_BCRYPT);
}

export function compararPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

/**
 * ¿Este hash se hizo con un costo menor al vigente? Se usa en un login
 * exitoso para re-hashear sin pedirle la clave a nadie. Lo que no parece un
 * hash bcrypt se reporta como "necesita", para que se regenere.
 */
export function necesitaRehash(hash) {
  if (typeof hash !== "string" || !hash.startsWith("$2")) return true;
  try {
    return bcrypt.getRounds(hash) < COSTO_BCRYPT;
  } catch {
    return true;
  }
}

function fragmentosIdentidad({ email, dni } = {}) {
  const fragmentos = [];
  if (typeof email === "string") {
    const usuario = email.trim().toLowerCase().split("@")[0];
    if (usuario.length >= 4) fragmentos.push({ valor: usuario, nombre: "email" });
  }
  if (typeof dni === "string") {
    const digitos = dni.replace(/\D/g, "");
    if (digitos.length >= 7) fragmentos.push({ valor: digitos, nombre: "DNI" });
  }
  return fragmentos;
}

/**
 * Devuelve el motivo de rechazo, o `null` si la contraseña es aceptable.
 *
 * Sin reglas de composición (mayúscula/número/símbolo): empujan a
 * `Password1!` y bajan la entropía real. Lo que defiende es el largo mínimo,
 * la lista de comunes, y que no contenga la identidad de la propia cuenta.
 */
export function motivoPasswordRechazada(password, contexto = {}) {
  if (typeof password !== "string" || password.length < LARGO_MIN_PASSWORD) {
    return `La contraseña debe tener al menos ${LARGO_MIN_PASSWORD} caracteres.`;
  }
  if (password.length > LARGO_MAX_PASSWORD) {
    return `La contraseña no puede superar los ${LARGO_MAX_PASSWORD} caracteres.`;
  }
  const enMinusculas = password.toLowerCase();
  if (PASSWORDS_COMUNES.has(enMinusculas)) {
    return "Esa contraseña es muy común. Elegí otra.";
  }
  for (const { valor, nombre } of fragmentosIdentidad(contexto)) {
    if (enMinusculas.includes(valor)) {
      return `La contraseña no puede contener tu ${nombre}.`;
    }
  }
  return null;
}
