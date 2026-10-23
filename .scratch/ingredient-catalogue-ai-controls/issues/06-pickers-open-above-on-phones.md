# 06 In-panel search pickers open above the input on phones

Status: ready-for-agent

Spec: Solution 9

## What

- One shared in-panel combobox popover (wrapping `PanelPortal` + `ComboBox.Popover`) that, on a phone, places the results above the input with a capped height. The parent picker (`components/ingredients/ingredient-picker.tsx`), the store-product field (`components/groceries/grocery-product-field.tsx`) and the nutrition correction's food search (`components/ingredients/nutrition-correction-panel.tsx`) use it.
- Root cause to respect: the popover opens nearly empty, so React Aria's flip never triggers, and the Panel's `repositionInputs={false}` leaves the input near the keyboard.

## Acceptance

- E2E on a phone viewport: typing in the parent picker and the store-product field shows results above the input, and a result can be tapped.
- Desktop placement unchanged.
