import { Router } from "express";
import { servirRobots } from "../controllers/robots.controller.js";

const router = Router();

// Sin rate limit: no toca la base, la respuesta es una constante interpolada.
router.get("/", servirRobots);

export default router;
