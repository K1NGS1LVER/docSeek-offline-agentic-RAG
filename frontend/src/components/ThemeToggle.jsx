import { useState, useEffect } from 'react';
import { Sun, Moon } from 'lucide-react';
import { motion } from 'framer-motion';

// Default to Dark Mode if no preference, or if user explicitly chose dark, or if system is dark
const getInitialDark = () =>
    !('theme' in localStorage) ||
    localStorage.theme === 'dark' ||
    window.matchMedia('(prefers-color-scheme: dark)').matches;

const ThemeToggle = () => {
    const [isDark, setIsDark] = useState(getInitialDark);

    useEffect(() => {
        document.documentElement.classList.toggle('dark', isDark);
    }, [isDark]);

    const toggleTheme = () => {
        localStorage.theme = isDark ? 'light' : 'dark';
        setIsDark(!isDark);
    };

    return (
        <button
            onClick={toggleTheme}
            className="p-2 rounded-full hover:bg-slate-100 dark:hover:bg-white/10 transition-colors text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white"
            aria-label="Toggle Theme"
        >
            <motion.div
                initial={false}
                animate={{ rotate: isDark ? 0 : 180 }}
                transition={{ duration: 0.3 }}
            >
                {isDark ? <Moon className="w-6 h-6" /> : <Sun className="w-6 h-6" />}
            </motion.div>
        </button>
    );
};

export default ThemeToggle;
