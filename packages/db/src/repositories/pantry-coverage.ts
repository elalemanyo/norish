import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";

/**
 * `covered(ingredient_id, depth)`: every food the members' Pantry covers, the
 * kept Ingredients and each food they are a kind of. Goes after `with recursive`.
 */
export function coveredCte(userIds: readonly string[]): SQL {
  const members = sql.join(
    userIds.map((id) => sql`${id}`),
    sql`, `
  );

  return sql`covered(ingredient_id, depth) as (
      select p.ingredient_id, 0 from pantry_ingredients p where p.user_id in (${members})
      union
      select i.parent_id, c.depth + 1 from covered c
      join ingredients i on i.id = c.ingredient_id
      where i.parent_id is not null and c.depth < 32
    )`;
}

/**
 * Recipes the household can cook from its Pantry (#679): at least one line
 * names a food, and every such line is in the pantry by `pantryIngredientFor`'s
 * rule: a line of alternatives by any of its foods, any other line by all.
 */
export function pantryCoversRecipeSql(userIds: readonly string[]): SQL {
  const covered = sql`(with recursive ${coveredCte(userIds)} select ingredient_id from covered)`;

  return sql`(
    EXISTS (
      SELECT 1 FROM recipe_ingredients line
      JOIN recipe_ingredient_foods line_food ON line_food.recipe_ingredient_id = line.id
      WHERE line.recipe_id = "recipes"."id"
    )
    AND NOT EXISTS (
      SELECT 1 FROM recipe_ingredients line
      JOIN recipe_ingredient_foods line_food ON line_food.recipe_ingredient_id = line.id
      JOIN ingredient_aliases alias ON alias.id = line_food.ingredient_alias_id
      WHERE line.recipe_id = "recipes"."id"
      GROUP BY line.id, line.joined
      HAVING CASE WHEN line.joined = 'alternatives'
        THEN NOT bool_or(alias.ingredient_id IN ${covered})
        ELSE NOT bool_and(alias.ingredient_id IN ${covered})
      END
    )
  )`;
}
