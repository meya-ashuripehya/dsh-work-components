package com.trix.gamebot.bridge.compat.farmersdelight;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ServingMathTest {
    @Test
    void pieAdvancesUntilTheLastBiteRemovesIt() {
        ServingMath.Change first = ServingMath.pie(0, 3);
        assertFalse(first.destroy());
        assertEquals(1, first.next());
        ServingMath.Change last = ServingMath.pie(3, 3);
        assertTrue(last.destroy());
        assertEquals(3, last.next());
    }

    @Test
    void feastShrinksUntilTheEmptyServingRemovesIt() {
        ServingMath.Change next = ServingMath.feast(4, 0);
        assertFalse(next.destroy());
        assertEquals(3, next.next());
        ServingMath.Change empty = ServingMath.feast(0, 0);
        assertTrue(empty.destroy());
    }
}
