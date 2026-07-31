import { definePreset } from '@primeng/themes';
import Material from '@primeng/themes/material';

export default definePreset(Material, {
    semantic: {
        primary: {
            50:  '#f5f7fa',
            100: '#e7edf3',
            200: '#cdd8e5',
            300: '#a1b5cf',
            400: '#7f9bbd',
            500: '#5e81ac',
            600: '#4b6a91',
            700: '#3d5676',
            800: '#2d4058',
            900: '#1f2d3d',
            950: '#17202c'
        }
    },
    components: {
        toggleswitch: {
            colorScheme: {
                light: {
                    root: {
                        background: '#434c5e',        // nord2
                        hoverBackground: '#4c566a',    // nord3
                        checkedBackground: '#81a1c1',  // nord9
                        checkedHoverBackground: '#81a1c1'
                    },
                    handle: {
                        background: '#eceff4',         // nord6
                        hoverBackground: '#eceff4',
                        checkedBackground: '#eceff4',
                        checkedHoverBackground: '#eceff4'
                    }
                }
            }
        },
        togglebutton: {
            colorScheme: {
                light: {
                    root: {
                        background: '#434c5e',         // nord2
                        borderColor: '#4c566a',        // nord3
                        color: '#eceff4',               // nord6
                        hoverColor: '#eceff4',
                        hoverBackground: '#4c566a',     // nord3
                        checkedBackground: '#81a1c1',   // nord9
                        checkedBorderColor: '#81a1c1',  // nord9
                        checkedColor: '#2e3440'         // nord0, contrasts against the light accent
                    }
                }
            }
        }
    }
});
