import Database from "better-sqlite3";
import { createApp } from "./app.js";

const db = new Database("demo.db");
createApp(db).listen(3000, () => console.log("http://localhost:3000"));