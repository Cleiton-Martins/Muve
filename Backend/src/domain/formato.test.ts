import { describe, expect, it } from "vitest";
import { horarioLocalDoEvento } from "@muve/shared/dominio.ts";
import { formatDateTime } from "./formato.ts";

describe("data e hora nos avisos do servidor", () => {
  it("mostra o horário digitado no fuso do estado do evento", () => {
    const inicio = horarioLocalDoEvento("2026-11-14", "21:00", "AM").toISOString();

    expect(formatDateTime(inicio, "AM")).toBe("14/11/2026 às 21:00");
  });
});
