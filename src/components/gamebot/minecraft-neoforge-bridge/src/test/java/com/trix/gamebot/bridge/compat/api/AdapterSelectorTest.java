package com.trix.gamebot.bridge.compat.api;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

class AdapterSelectorTest {
    @Test
    void higherPriorityWinsAndMissingModsAreSkipped() {
        Candidate vanilla = new Candidate("vanilla", null, 0, true);
        Candidate farmers = new Candidate("farmersdelight", "farmersdelight", 100, true);
        Candidate absent = new Candidate("create", "create", 200, true);
        Candidate chosen = AdapterSelector.select(
                List.of(vanilla, absent, farmers),
                candidate -> candidate.requiredMod == null || Set.of("farmersdelight").contains(candidate.requiredMod),
                candidate -> candidate.priority,
                candidate -> candidate.supports,
                candidate -> candidate.id
        );
        assertEquals("farmersdelight", chosen.id);
    }

    @Test
    void unsupportedBlockSelectsNothing() {
        Candidate vanilla = new Candidate("vanilla", null, 0, false);
        Candidate chosen = AdapterSelector.select(
                List.of(vanilla),
                candidate -> true,
                candidate -> candidate.priority,
                candidate -> candidate.supports,
                candidate -> candidate.id
        );
        assertNull(chosen);
    }

    private record Candidate(String id, String requiredMod, int priority, boolean supports) {
    }
}
