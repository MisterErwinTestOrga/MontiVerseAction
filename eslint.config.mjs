import js from "@eslint/js";
import globals from "globals";

export default [
    {
        ignores: ['dist'],
    },
    js.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 2020,
            globals: {
                ...globals.node,
            },
        },
        rules: {
        },
    },
];
