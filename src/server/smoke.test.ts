import { describe, expect, it } from "vitest";

import { serviceIdentity } from "@/server/service-identity";

describe("serviceIdentity", () => {
  it("identifies the v1 FitGridWeb service", () => {
    expect(serviceIdentity()).toEqual({ name: "fitgridweb", apiVersion: "v1" });
  });
});
