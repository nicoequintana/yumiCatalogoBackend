/**
 * Las contraseñas más usadas, en minúsculas. Con solo el mínimo de 8
 * caracteres, "12345678" y "contraseña" pasan, y son las primeras que prueba
 * cualquier ataque de diccionario. La lista es corta a propósito: no es un
 * diccionario, es el techo de lo que no se acepta ni con rate limit.
 */
export const PASSWORDS_COMUNES = new Set([
  "12345678", "123456789", "1234567890", "12345678910", "987654321",
  "password", "password1", "password12", "password123", "passw0rd",
  "contraseña", "contrasena", "contraseña1", "contrasena1", "contraseña123",
  "qwertyui", "qwertyuiop", "qwerty123", "qwerty1234", "1q2w3e4r", "1q2w3e4r5t",
  "asdfghjk", "asdfghjkl", "zxcvbnm1", "asdf1234",
  "11111111", "00000000", "22222222", "88888888", "99999999",
  "abcd1234", "abc12345", "abcdefgh", "abcdefg1", "a1b2c3d4",
  "iloveyou", "iloveyou1", "loveyou1", "teamo123", "tequiero",
  "letmein1", "welcome1", "welcome123", "admin123", "admin1234",
  "sunshine", "princess", "football", "baseball", "superman", "batman123",
  "argentina", "argentina1", "boca1905", "bocajuniors", "riverplate", "river1901",
  "messi10", "messi123", "maradona", "diego10", "leomessi",
  "buenosaires", "cordoba1", "rosario1", "mendoza1",
  "hola1234", "hola12345", "holahola", "chau1234",
  "trustno1", "dragon12", "monkey12", "shadow12", "master12", "michael1",
  "jennifer", "jordan23", "charlie1", "daniel12", "matias12",
  "computadora", "computer", "internet", "internet1", "telefono",
  "cumpleaños", "cumpleanos", "cumple123", "familia1", "familia123",
  "mipassword", "mipass123", "clave123", "clave1234", "miclave1", "miclave123",
  "secreto1", "secreto123", "secret123",
  "19701970", "19801980", "19901990", "20002000", "20102010", "20202020",
  "01011990", "01011980", "01012000", "10101010", "12121212", "31121999",
  "yima1234", "yima2024", "yima2025", "yima2026",
  "aaaaaaaa", "bbbbbbbb", "zzzzzzzz", "xxxxxxxx",
  "1234abcd", "1234qwer", "qwer1234", "asdf;lkj",
  "changeme", "cambiame", "temporal", "temporal1", "prueba123", "test1234", "testtest",
  "nintendo", "playstation", "fortnite", "minecraft", "pokemon1",
  "whatsapp", "facebook", "facebook1", "instagram", "youtube1", "google123",
  "mercadolibre", "mercadopago", "amazon123",
  "corazon1", "amor1234", "amorcito", "mihijo123", "mihija123", "mimama123",
  "estrella", "estrella1", "mariposa", "primavera", "verano2024", "invierno",
  "perro123", "gato1234", "tobias12", "firulais", "michi123",
]);
