import { describe, expect, it } from "vitest";
import { horarioLocalDoEvento } from "@muve/shared/dominio.ts";
import { eventDateParts } from "./format.ts";

describe("horário do evento na tela", () => {
  it("mostra o mesmo horário que foi digitado, para quem estiver em qualquer fuso", () => {
    const inicio = horarioLocalDoEvento("2026-11-14", "21:00", "AM").toISOString();

    expect(eventDateParts(inicio, "AM")).toMatchObject({ day: "14", time: "21:00", data: "14/11/2026", weekday: "SÁB", cartaz: "SÁB 14 NOV · 21H" });
  });
});
