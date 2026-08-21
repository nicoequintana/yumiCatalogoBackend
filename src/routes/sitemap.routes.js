import { Router } from "express";
import { servirSitemap } from "../controllers/sitemap.controller.js";

const router = Router();

router.get("/", servirSitemap);

export default router;
